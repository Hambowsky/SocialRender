// Email marketing contacts: who can get the newsletter. People David knows (clients, enquiries, leads who replied)
// and people who signed up on the website and confirmed. Cold leads are never added. The Do not email list is
// shared with outreach, so unsubscribing from either stops both.
import crypto from 'node:crypto';
import { db } from './db.ts';
import { API_KEY, fail, NEWS_FROM, PUBLIC_URL, RESEND_API_KEY, RESEND_API_URL, SIGNUP_DAILY_CAP } from './config.ts';
import { esc } from './markdown.ts';

export type Contact = { id: number; email: string; name: string; business: string; tags: string; source: string; status: string;
  lead_id: number | null; confirm_sent_at: string | null; confirmed_at: string | null; created_at: string; unsubscribed: number };
type Row = { email: string; name?: string; business?: string; tags?: string };

const norm = (email: string) => email.trim().toLowerCase();
const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[a-z]{2,}$/i;
const tagList = (tags: string) => [...new Set(tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean))];
const SELECT = `SELECT c.*, EXISTS (SELECT 1 FROM suppression s WHERE s.email = c.email) AS unsubscribed FROM contacts c`;

export function list(q: { tag?: string; status?: string } = {}) {
  const all = db.prepare(`${SELECT} ORDER BY c.id DESC`).all() as Contact[];
  const counts = { subscribed: all.filter(c => c.status === 'subscribed' && !c.unsubscribed).length, pending: all.filter(c => c.status === 'pending' && !c.unsubscribed).length,
    unsubscribed: all.filter(c => c.unsubscribed).length };
  const tags = [...new Set(all.flatMap(c => tagList(c.tags)))].sort();
  const contacts = all.filter(c => (!q.tag || tagList(c.tags).includes(q.tag.toLowerCase()))
    && (!q.status || (q.status === 'unsubscribed' ? !!c.unsubscribed : c.status === q.status && !c.unsubscribed)));
  return { contacts, counts, tags };
}

const get = (id: number) => (db.prepare(`${SELECT} WHERE c.id = ?`).get(id) as Contact | undefined) ?? fail(404, `There is no contact ${id}`);

// David adds people he knows, so they go straight in as subscribed. An address already there keeps its details
// and gains any new tags; blank fields are filled in.
export function save(rows: Row[], source = 'added', leadId?: number) {
  let added = 0, updated = 0;
  const invalid: string[] = [];
  for (const r of rows) {
    const email = norm(r.email);
    if (!EMAIL.test(email)) { invalid.push(r.email); continue; }
    const tags = tagList(r.tags ?? '').join(', '), was = db.prepare('SELECT * FROM contacts WHERE email = ?').get(email) as Contact | undefined;
    if (!was) {
      db.prepare(`INSERT INTO contacts (email, name, business, tags, source, status, lead_id) VALUES (?, ?, ?, ?, ?, 'subscribed', ?)`)
        .run(email, r.name?.trim() ?? '', r.business?.trim() ?? '', tags, source, leadId ?? null);
      added++;
      continue;
    }
    const merged = tagList(`${was.tags},${tags}`).join(', ');
    const changes = db.prepare(`UPDATE contacts SET name = CASE name WHEN '' THEN ? ELSE name END, business = CASE business WHEN '' THEN ? ELSE business END,
      tags = ?, lead_id = coalesce(lead_id, ?), status = 'subscribed' WHERE id = ?`).run(r.name?.trim() ?? '', r.business?.trim() ?? '', merged, leadId ?? null, was.id).changes;
    updated += Number(changes);
  }
  return { added, updated, invalid };
}

// Pasted lines: "email, name, business" in any order of columns after the email, or a CSV with a header row.
export function parse(text: string): Row[] {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const cells = (l: string) => l.split(/[,\t;]/).map(c => c.trim().replace(/^"|"$/g, ''));
  const head = lines[0] && !lines[0].includes('@') ? cells(lines[0]).map(h => h.toLowerCase()) : null;
  const col = (names: string[]) => head?.findIndex(h => names.some(n => h.includes(n))) ?? -1;
  const at = { email: col(['email']), name: col(['name']), business: col(['business', 'company', 'organisation', 'organization']) };
  return (head ? lines.slice(1) : lines).map(l => {
    const c = cells(l);
    if (head && at.email >= 0) return { email: c.at(at.email) ?? '', name: at.name >= 0 ? c.at(at.name) : '', business: at.business >= 0 ? c.at(at.business) : '' };
    const i = c.findIndex(x => x.includes('@'));
    const rest = c.filter((_, j) => j !== i);
    return { email: c.at(i) ?? l, name: rest[0] ?? '', business: rest[1] ?? '' };
  });
}

// Leads who answered an outreach email know who David is, so they can have the newsletter.
export function importReplied() {
  const leads = db.prepare(`SELECT id, email, contact_name, company_name FROM leads WHERE status = 'replied' AND email != ''`).all() as { id: number; email: string; contact_name: string; company_name: string }[];
  const out = { added: 0, updated: 0, invalid: [] as string[] };
  for (const l of leads) {
    const r = save([{ email: l.email, name: l.contact_name, business: l.company_name, tags: 'replied lead' }], 'lead', l.id);
    out.added += r.added; out.updated += r.updated; out.invalid.push(...r.invalid);
  }
  return out;
}

// Contacts David added in Resend's dashboard come across too. Anyone Resend has as unsubscribed goes on the
// Do not email list, so they are skipped here as well.
export async function importResend() {
  if (!RESEND_API_KEY) fail(503, 'RESEND_API_KEY is not set');
  const out = { found: 0, added: 0, updated: 0, unsubscribed: 0, invalid: [] as string[] };
  let after = '';
  for (let page = 0; page < 100; page++) { // ponytail: 10,000 contacts max, raise if the list ever gets near it
    const res = await fetch(`${RESEND_API_URL}/contacts?${new URLSearchParams({ limit: '100', ...(after && { after }) })}`, {
      signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${RESEND_API_KEY}` } });
    const body = await res.json().catch(() => ({})) as { data?: { id: string; email: string; first_name?: string; last_name?: string; unsubscribed?: boolean }[]; has_more?: boolean; message?: string };
    if (res.status === 401 || res.status === 403) fail(502, `Resend would not list contacts (${body.message ?? res.status}). The API key needs Full access, not Sending access only.`);
    if (!res.ok) fail(502, `Resend: ${body.message ?? res.status}`);
    for (const c of body.data ?? []) {
      out.found++;
      const r = save([{ email: c.email, name: [c.first_name, c.last_name].filter(Boolean).join(' '), tags: 'resend' }], 'resend');
      out.added += r.added; out.updated += r.updated; out.invalid.push(...r.invalid);
      if (c.unsubscribed && Number(db.prepare(`INSERT INTO suppression (email, reason) VALUES (?, 'unsubscribed') ON CONFLICT DO NOTHING`).run(norm(c.email)).changes)) out.unsubscribed++;
    }
    if (!body.has_more || !body.data?.length) break;
    after = body.data.at(-1)!.id;
  }
  return out;
}

// Segments and topics live in Resend, where David manages them, so the studio reads and changes them there.
// Resend accepts an email address wherever it wants a contact id.
export async function resend(path: string, init: { method?: string; body?: unknown } = {}) {
  if (!RESEND_API_KEY) fail(503, 'RESEND_API_KEY is not set');
  const res = await fetch(`${RESEND_API_URL}${path}`, { method: init.method ?? 'GET', signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${RESEND_API_KEY}`, 'content-type': 'application/json' }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const body = await res.json().catch(() => ({})) as any;
  if (res.ok) return body;
  const msg = res.status === 401 || res.status === 403 ? `Resend said no (${body.message ?? res.status}). The API key needs Full access, not Sending access only.` : `Resend: ${body.message ?? res.status}`;
  throw Object.assign(new Error(msg), { statusCode: res.status === 404 ? 404 : 502, resendStatus: res.status }); // resendStatus: what Resend itself answered
}
async function all(path: string) {
  const out: any[] = [];
  let after = '';
  for (let page = 0; page < 100; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const body = await resend(`${path}${sep}${new URLSearchParams({ limit: '100', ...(after && { after }) })}`);
    out.push(...(body.data ?? []));
    if (!body.has_more || !body.data?.length) break;
    after = body.data.at(-1).id;
  }
  return out;
}

// Every segment and topic, and who is in each segment, so the contacts table can show them.
export async function audience() {
  const [segments, topics] = await Promise.all([all('/segments'), all('/topics')]);
  const members: Record<string, string[]> = {};
  for (const s of segments) for (const c of await all(`/contacts?segment_id=${encodeURIComponent(s.id)}`)) (members[norm(c.email)] ??= []).push(s.id);
  return { segments: segments.map(s => ({ id: s.id, name: s.name })),
    topics: topics.map(t => ({ id: t.id, name: t.name, description: t.description ?? '', default_subscription: t.default_subscription })), members };
}

export const createSegment = async (name: string) => resend('/segments', { method: 'POST', body: { name: name.trim() } });
export const createTopic = async (t: { name: string; description?: string; default_subscription: 'opt_in' | 'opt_out' }) =>
  resend('/topics', { method: 'POST', body: { name: t.name.trim(), description: t.description?.trim() || undefined, default_subscription: t.default_subscription } });

// One contact's segments and topic choices. Someone not in Resend yet has none.
export async function resendOf(id: number) {
  const key = encodeURIComponent(get(id).email);
  try {
    const [segs, topics] = await Promise.all([all(`/contacts/${key}/segments`), resend(`/contacts/${key}/topics`)]);
    return { inResend: true, segments: segs.map(s => s.id as string), topics: (topics.data ?? []).map((t: any) => ({ id: t.id, subscription: t.subscription })) };
  } catch (e: any) { if (e.statusCode === 404) return { inResend: false, segments: [], topics: [] }; throw e; }
}

// Puts a contact in exactly these segments and sets these topic choices, adding them to Resend first if needed.
// Only subscribed people who have not unsubscribed can be added, so nobody unconfirmed ends up on a Resend list.
export async function setResend(id: number, want: { segments: string[]; topics: { id: string; subscription: 'opt_in' | 'opt_out' }[] }) {
  const c = get(id) as Contact & { unsubscribed?: number };
  const now = await resendOf(id), key = encodeURIComponent(c.email);
  if (!now.inResend) {
    if (c.status !== 'subscribed' || db.prepare('SELECT 1 FROM suppression WHERE email = ?').get(norm(c.email))) fail(409, 'Only subscribed contacts can be added to Resend');
    const [first_name, ...rest] = c.name.split(' ');
    await resend('/contacts', { method: 'POST', body: { email: c.email, first_name: first_name || undefined, last_name: rest.join(' ') || undefined, unsubscribed: false } });
  }
  for (const s of want.segments.filter(s => !now.segments.includes(s))) await resend(`/contacts/${key}/segments/${encodeURIComponent(s)}`, { method: 'POST' });
  for (const s of now.segments.filter(s => !want.segments.includes(s))) await resend(`/contacts/${key}/segments/${encodeURIComponent(s)}`, { method: 'DELETE' });
  if (want.topics.length) await resend(`/contacts/${key}/topics`, { method: 'PATCH', body: { topics: want.topics } });
  return resendOf(id);
}

// The segment new website sign ups go into, chosen on the Email page.
export const signupSegment = () => (db.prepare(`SELECT value FROM settings WHERE key = 'signup_segment'`).get() as { value: string } | undefined)?.value ?? '';
export function setSignupSegment(id: string) {
  db.prepare(`INSERT INTO settings (key, value) VALUES ('signup_segment', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(id);
  return { segment_id: id };
}

// A confirmed sign up goes into Resend with their first and last name, and into the sign up segment.
async function toResend(email: string) {
  if (!RESEND_API_KEY) return;
  const c = db.prepare('SELECT name FROM contacts WHERE email = ?').get(email) as { name: string };
  const [first_name = '', ...rest] = c.name.trim().split(/\s+/), names = { first_name, last_name: rest.join(' ') };
  const key = encodeURIComponent(email);
  try { await resend(`/contacts/${key}`); await resend(`/contacts/${key}`, { method: 'PATCH', body: { ...names, unsubscribed: false } }); }
  catch (e: any) { if (e.statusCode !== 404) throw e; await resend('/contacts', { method: 'POST', body: { email, ...names, unsubscribed: false } }); }
  const seg = signupSegment();
  if (seg) await resend(`/contacts/${key}/segments/${encodeURIComponent(seg)}`, { method: 'POST' });
}

export function update(id: number, body: { name?: string; business?: string; tags?: string }) {
  get(id);
  db.prepare('UPDATE contacts SET name = coalesce(?, name), business = coalesce(?, business), tags = coalesce(?, tags) WHERE id = ?')
    .run(body.name?.trim() ?? null, body.business?.trim() ?? null, body.tags === undefined ? null : tagList(body.tags).join(', '), id);
  return get(id);
}

export function remove(id: number) {
  get(id);
  db.prepare('DELETE FROM contacts WHERE id = ?').run(id);
  return { ok: true };
}

// One email through Resend. The key stays on the server; a failure says what Resend said.
export async function sendEmail(m: { to: string; subject: string; html: string; text: string; headers?: Record<string, string> }) {
  if (!RESEND_API_KEY) fail(503, 'RESEND_API_KEY is not set, so email marketing cannot send yet');
  const res = await fetch(`${RESEND_API_URL}/emails`, { method: 'POST', signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: NEWS_FROM, to: [m.to], subject: m.subject, html: m.html, text: m.text, headers: m.headers }) });
  const body = await res.json().catch(() => ({})) as { id?: string; message?: string };
  if (!res.ok) fail(502, `Resend: ${body.message ?? res.status}`);
  return body.id ?? '';
}

// Sign up from the website: a confirm email first, so a typo or someone else's address never ends up on the list.
const confirmToken = (email: string) => crypto.createHmac('sha256', API_KEY).update(`confirm:${norm(email)}`).digest('base64url').slice(0, 24);
export const validConfirm = (email: string, token: string) => {
  const want = Buffer.from(confirmToken(email)), got = Buffer.from(token);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
};
const recent = new Map<string, number[]>(); // ponytail: in memory, so a restart forgets; fine for one small server

const FROM_TAGS = ['popup', 'footer', 'enquiry']; // where on the website they signed up, kept as a tag
export async function signup(input: { email: string; name?: string; from?: string }, ip = '') {
  const email = norm(input.email);
  if (!EMAIL.test(email)) fail(400, 'That email address does not look right');
  if (!PUBLIC_URL) fail(503, 'Set PUBLIC_URL first: the confirm email needs a working link');
  const hour = Date.now() - 3_600_000, mine = (recent.get(ip) ?? []).filter(t => t > hour);
  if (mine.length >= 5) fail(429, 'Too many sign ups from here. Please try again later.');
  recent.set(ip, [...mine, Date.now()]);
  const was = db.prepare('SELECT * FROM contacts WHERE email = ?').get(email) as Contact | undefined;
  // Already on the list, or a confirm email went out in the last day: say the same thing, send nothing.
  if (was?.status === 'subscribed' && !db.prepare('SELECT 1 FROM suppression WHERE email = ?').get(email)) return { ok: true };
  if (was?.confirm_sent_at && Date.parse(`${was.confirm_sent_at}Z`) > Date.now() - 86_400_000) return { ok: true };
  const today = (db.prepare(`SELECT count(*) AS n FROM contacts WHERE confirm_sent_at >= datetime('now', 'start of day')`).get() as { n: number }).n;
  if (today >= SIGNUP_DAILY_CAP) fail(429, 'Sign ups are paused for today. Please try again tomorrow.');
  const link = `${PUBLIC_URL}/subscribe/confirm?${new URLSearchParams({ e: email, t: confirmToken(email) })}`;
  const name = input.name?.trim().slice(0, 100) ?? '';
  await sendEmail({ to: email, subject: 'Please confirm your Red Cherry IT newsletter sign up',
    text: `Hi${name ? ` ${name}` : ''},\n\nPlease confirm you would like the Red Cherry IT newsletter: practical website and marketing tips, once a month.\n\n${link}\n\nIf you did not sign up, ignore this email and you will not hear from us.\n\nRed Cherry IT · redcherryit.com`,
    html: `<div style="font:16px/1.5 Arial,sans-serif;color:#1a1a1a;max-width:520px"><p style="color:#b5333f;font-weight:800">Red Cherry IT</p><p>Hi${name ? ` ${esc(name)}` : ''},</p>
<p>Please confirm you would like the Red Cherry IT newsletter: practical website and marketing tips, once a month.</p>
<p><a href="${esc(link)}" style="display:inline-block;padding:12px 20px;background:#b5333f;color:#fff;border-radius:8px;text-decoration:none;font-weight:700">Confirm my sign up</a></p>
<p style="color:#444;font-size:14px">If you did not sign up, ignore this email and you will not hear from us.</p></div>` });
  if (was) db.prepare(`UPDATE contacts SET confirm_sent_at = datetime('now'), name = CASE name WHEN '' THEN ? ELSE name END WHERE id = ?`).run(name, was.id);
  else db.prepare(`INSERT INTO contacts (email, name, tags, source, status, confirm_sent_at) VALUES (?, ?, ?, 'signup', 'pending', datetime('now'))`)
    .run(email, name, ['newsletter', ...FROM_TAGS.filter(t => t === input.from)].join(', '));
  return { ok: true };
}

// Confirming lifts an earlier unsubscribe (they asked again), but never a bounce or a complaint.
export async function confirm(email: string, token: string) {
  if (!validConfirm(email, token)) fail(400, 'That confirm link is not valid');
  const e = norm(email);
  if (!db.prepare(`UPDATE contacts SET status = 'subscribed', confirmed_at = coalesce(confirmed_at, datetime('now')) WHERE email = ?`).run(e).changes)
    fail(404, 'We could not find that sign up. Please sign up again on redcherryit.com.');
  db.prepare(`DELETE FROM suppression WHERE email = ? AND reason = 'unsubscribed'`).run(e);
  await toResend(e).catch(err => console.error(`Sign up ${e} not added to Resend: ${err.message}`)); // they are still on the list here
  return { ok: true };
}
