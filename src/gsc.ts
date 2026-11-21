// Search Console watch: last week's Google clicks and rankings for redcherryit.com against the week before.
// Plain API calls, no Claude. Signs in as a Google service account that David adds as a user on the property.
import crypto from 'node:crypto';
import { db } from './db.ts';
import { fail, GSC_API_URL, GSC_CREDENTIALS, GSC_SITE, GSC_TOKEN_URL } from './config.ts';

type Row = { keys: string[]; clicks: number; impressions: number; ctr: number; position: number };
type Credentials = { client_email: string; private_key: string };

function credentials(): Credentials {
  if (!GSC_CREDENTIALS) fail(503, 'GSC_CREDENTIALS is not set, so Search Console is off');
  try {
    const text = GSC_CREDENTIALS.trim().startsWith('{') ? GSC_CREDENTIALS : Buffer.from(GSC_CREDENTIALS, 'base64').toString('utf8');
    const c = JSON.parse(text);
    if (c.client_email && c.private_key) return c;
  } catch { /* falls through */ }
  return fail(503, 'GSC_CREDENTIALS is not a Google service account key (the JSON file, or that file in base64)');
}

// A signed JWT swapped for an access token, kept until a minute before it runs out. The promise is shared,
// so queries that start together sign in once.
let token: { value: Promise<string>; until: number } | undefined;
export function accessToken() {
  if (!token || token.until <= Date.now()) {
    token = { value: signIn(), until: Date.now() + 50 * 60_000 };
    token.value.catch(() => { token = undefined; });
  }
  return token.value;
}
async function signIn() {
  const c = credentials(), now = Math.floor(Date.now() / 1000);
  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: c.client_email, scope: 'https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly', aud: GSC_TOKEN_URL, iat: now, exp: now + 3600 })}`;
  const jwt = `${unsigned}.${crypto.sign('RSA-SHA256', Buffer.from(unsigned), c.private_key).toString('base64url')}`;
  const res = await fetch(GSC_TOKEN_URL, { method: 'POST', signal: AbortSignal.timeout(20_000), headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }) });
  const body = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !body.access_token) fail(502, `Google sign in failed: ${body.error_description ?? res.status}`);
  return body.access_token!;
}

export const serviceEmail = () => credentials().client_email;

export async function query(startDate: string, endDate: string, dimensions: string[], site = GSC_SITE) {
  const res = await fetch(`${GSC_API_URL}/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
    method: 'POST', signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ startDate, endDate, dimensions, rowLimit: 250 }),
  });
  const body = await res.json().catch(() => ({})) as { rows?: Row[]; error?: { message?: string } };
  if (res.status === 403) fail(502, `Search Console refused: add ${credentials().client_email} as a user on ${site} in Search Console`);
  if (!res.ok) fail(502, `Search Console: ${body.error?.message ?? res.status}`);
  return body.rows ?? [];
}

const day = (d: Date, back: number) => new Date(d.getTime() - back * 86_400_000).toISOString().slice(0, 10);
const round = (n: number, dp = 1) => +n.toFixed(dp);

// Google's figures settle after about three days, so the week ends three days ago.
export async function week(now = new Date()) {
  const key = `gsc:${now.toISOString().slice(0, 10)}`;
  const saved = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (saved) return withBuild(JSON.parse(saved.value)); // once a day is plenty: the numbers only move daily
  const to = day(now, 3), from = day(now, 9), prevTo = day(now, 10), prevFrom = day(now, 16);
  const [total, totalPrev, pages, pagesPrev, queries] = await Promise.all([
    query(from, to, []), query(prevFrom, prevTo, []), query(from, to, ['page']), query(prevFrom, prevTo, ['page']), query(from, to, ['query', 'page'])]);
  const sum = (r?: Row) => ({ clicks: r?.clicks ?? 0, impressions: r?.impressions ?? 0, ctr: round((r?.ctr ?? 0) * 100), position: round(r?.position ?? 0) });
  const before = new Map(pagesPrev.map(r => [r.keys[0], r]));
  const moves = [...new Set([...pages.map(r => r.keys[0]), ...before.keys()])].map(page => {
    const cur = pages.find(r => r.keys[0] === page), was = before.get(page);
    return { page, clicks: cur?.clicks ?? 0, change: (cur?.clicks ?? 0) - (was?.clicks ?? 0), position: round(cur?.position ?? 0) };
  });
  const result = {
    site: GSC_SITE, from, to,
    totals: { ...sum(total[0]), before: sum(totalPrev[0]) },
    rising: moves.filter(m => m.change > 0).sort((a, b) => b.change - a.change).slice(0, 5),
    falling: moves.filter(m => m.change < 0).sort((a, b) => a.change - b.change).slice(0, 5),
    top_pages: [...pages].sort((a, b) => b.clicks - a.clicks).slice(0, 5).map(r => ({ page: r.keys[0], clicks: r.clicks, position: round(r.position) })),
    // Searches we already show for but just off page one: the cheapest rankings to win with a better page.
    chances: byQuery(queries).filter(r => r.position >= 8 && r.position <= 20 && r.impressions >= 10).sort((a, b) => b.impressions - a.impressions).slice(0, 10),
  };
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(key, JSON.stringify(result));
  db.prepare(`DELETE FROM settings WHERE key LIKE 'gsc:%' AND key < ?`).run(`gsc:${day(now, 14)}`);
  return withBuild(result);
}

// Query and page rows folded into one per search: totals, the average position weighted by impressions,
// and the page Google shows most for it.
function byQuery(rows: Row[]) {
  const out = new Map<string, { query: string; impressions: number; clicks: number; position: number; page: string; top: number }>();
  for (const r of rows) {
    const q = out.get(r.keys[0]) ?? { query: r.keys[0], impressions: 0, clicks: 0, position: 0, page: '', top: -1 };
    q.position = (q.position * q.impressions + r.position * r.impressions) / (q.impressions + r.impressions || 1);
    q.impressions += r.impressions; q.clicks += r.clicks;
    if (r.impressions > q.top) { q.top = r.impressions; q.page = r.keys[1] ?? ''; }
    out.set(r.keys[0], q);
  }
  return [...out.values()].map(({ top, ...q }) => ({ ...q, position: round(q.position) }));
}

// What to build for a search we nearly rank for. Plain rules, no Claude: a guide that already ranks gets
// updated; otherwise a new guide aimed at the search, in the category that fits, linking to the page that ranks.
const LOCAL = /\bnear me\b|\b(newcastle|durham|sunderland|gateshead|middlesbrough|teesside|darlington|hartlepool|stockton|northumberland|tyneside|tyne and wear|north east|cumbria|carlisle|scotland|midlands)\b/;
export function recommend(query: string, page: string, position: number) {
  const q = query.toLowerCase(), path = page.replace(/^https?:\/\/[^/]+/, '').replace(/\.html$/, '') || '/';
  const guide = path.match(/^\/(guides\/[^/]+\/)([^/]+)$/);
  if (guide) return { kind: 'update', label: 'Update the guide', category: `/${guide[1]}`, slug: guide[2],
    why: `Your guide ${path} already shows for this at position ${position}. Add a section that answers it directly and publish it again.` };
  const category = LOCAL.test(q) ? '/guides/local/' : /\bvs\b|versus|compar|\bbest\b|\bor\b/.test(q) ? '/guides/comparisons/' : /checklist|\bsteps\b|\btips\b/.test(q) ? '/guides/checklists/' : '/guides/learn/';
  const where = path === '/' ? 'your home page' : path;
  return { kind: 'article', label: category === '/guides/local/' ? 'Write a local guide' : 'Write a guide', category,
    why: `${path === '/' ? 'Your home page' : `The page ${path}`} shows for this at position ${position} but is not built around it. A guide aimed at this search that links to ${where} gives Google a closer match.` };
}
const withBuild = (g: any) => ({ ...g, chances: g.chances.map((c: any) => ({ ...c, build: c.page ? recommend(c.query, c.page, c.position) : undefined })) });

// For Plan the week: when David gives no focus, aim the article at searches we nearly rank for.
export async function planFocus() {
  if (!GSC_CREDENTIALS) return '';
  try {
    const q = (await week()).chances.slice(0, 5).map((c: { query: string }) => `"${c.query}"`);
    return q.length ? `People already find redcherryit.com on Google for these searches, but just off page one: ${q.join(', ')}. Prefer an article that answers one of them better than anything else, so we move up.` : '';
  } catch { return ''; }
}
