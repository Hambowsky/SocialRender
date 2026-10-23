// Phase 3 of Sales: a closer look at each lead. PageSpeed, domain age, Business Profile and a screenshot are plain
// lookups; Claude then reads them and gives a priority, a note on why, and an opening line for David.
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.ts';
import { fail, FIRECRAWL_API_KEY, GOOGLE_PLACES_API_KEY, GOOGLE_PLACES_URL, PAGESPEED_URL, RDAP_URL } from './config.ts';
import { analysing, busy, cached, lead, screenshotPath } from './leads.ts';
import { screenshotSite } from './render.ts';
import { checkSite, findEmail, findSocial, scrape, scrapeShot } from './sitecheck.ts';
import { BROWSER, isChallenge } from './page.ts';
import { runPrompt } from './copy.ts';

type Analysis = {
  pagespeed?: { score: number; lcp: string };
  domain?: { registered: string; years: number };
  gbp?: { rating: number | null; reviews: number | null; has_hours?: boolean; photos?: number; maps_url?: string };
  screenshot?: boolean;
  notes?: string;
  pitch?: string;
  cost_gbp?: number;
  errors: string[];
};

async function getJson(url: string, init?: RequestInit, ms = 20_000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  const json = await res.json().catch(() => ({})) as any;
  if (!res.ok) fail(502, json?.error?.message ?? json?.description?.[0] ?? `returned ${res.status}`);
  return json;
}

// Google's mobile score, the one people see when they test their own site.
async function pageSpeed(site: string) {
  const q = new URLSearchParams({ url: site, strategy: 'mobile', category: 'performance' });
  // Without a key Google shares one small daily allowance between everyone, so in practice the key needs the PageSpeed Insights API on.
  if (GOOGLE_PLACES_API_KEY) q.set('key', GOOGLE_PLACES_API_KEY);
  const json = await getJson(`${PAGESPEED_URL}?${q}`, undefined, 90_000);
  const score = json.lighthouseResult?.categories?.performance?.score;
  if (typeof score !== 'number') fail(502, 'no score came back');
  return { score: Math.round(score * 100), lcp: json.lighthouseResult.audits?.['largest-contentful-paint']?.displayValue ?? '' };
}

// When the domain was first registered, from the public registry (RDAP), so a long established business stands out.
async function domainAge(site: string) {
  const domain = new URL(site).hostname.replace(/^www\./, '');
  const url = `${RDAP_URL}/domain/${encodeURIComponent(domain)}`;
  const json = await getJson(url, { headers: { accept: 'application/rdap+json', 'user-agent': BROWSER } }).catch(async (err: Error) => {
    // rdap.org and some registries turn cloud servers away (403), so Firecrawl fetches the record instead.
    if (!FIRECRAWL_API_KEY) throw err;
    const page = await scrape(url);
    try { return JSON.parse(page.html); } catch { fail(502, `${err.message}, and Firecrawl got no record either`); }
  });
  const date = json.events?.find((e: any) => e.eventAction === 'registration')?.eventDate;
  if (!date) fail(502, 'the registry gave no registration date');
  return { registered: date.slice(0, 10), years: Math.floor((Date.now() - Date.parse(date)) / (365.25 * 86_400_000)) };
}

const GBP_FIELDS = 'rating,userRatingCount,regularOpeningHours,photos,googleMapsUri';
async function businessProfile(placeId: string) {
  const json = await cached('places', { details: placeId }, () =>
    getJson(`${GOOGLE_PLACES_URL}/v1/places/${encodeURIComponent(placeId)}`, { headers: { 'x-goog-api-key': GOOGLE_PLACES_API_KEY, 'x-goog-fieldmask': GBP_FIELDS } }));
  return { rating: json.rating ?? null, reviews: json.userRatingCount ?? null, has_hours: !!json.regularOpeningHours, photos: json.photos?.length ?? 0, maps_url: json.googleMapsUri };
}

const describe = (o: Record<string, unknown>) => Object.entries(o).map(([k, v]) => v === true ? k : `${k}: ${v}`).join(', ') || 'none';

export async function analyseLead(id: number) {
  let l = lead(id) as any;
  const a: Analysis = { errors: [] };
  const step = async (name: string, work: () => Promise<void>) => {
    try { await work(); } catch (err) {
      if ((err as any).statusCode === 402) throw err; // the monthly AI cap: stop, rather than note it on every lead
      a.errors.push(`${name}: ${(err as Error).message}`);
    }
  };
  const site = l.website_url;
  let dead = l.lead_reason.startsWith('Website listed but unreachable');
  let check: Awaited<ReturnType<typeof checkSite>> | null = null;
  // Check the site again first: it may have been down, or turned the check away, when the lead was found.
  // When it loads, the lead's website details are brought up to date, including a reason that said it was unreachable.
  if (site) await step('Website check', async () => {
    check = await checkSite(site);
    if (!check.reachable) return void a.errors.push(`Website check: ${check.note}`);
    if (check.note) return; // up, but blocks automatic checks, so there is nothing new to record
    const issues = Object.keys(check.issues);
    const reason = issues.length ? `Outdated website: ${issues.join(', ')}` : 'Website loads, with no outdated signs found';
    db.prepare(`UPDATE leads SET has_website = 1, website_issues = ?, seo_issues = ?, social_links = ?, lead_reason = CASE WHEN ? THEN ? ELSE lead_reason END,
        updated_at = datetime('now') WHERE id = ?`)
      .run(JSON.stringify(check.issues), JSON.stringify(check.seo), JSON.stringify(check.social), dead ? 1 : 0, reason, id);
    if (dead) db.prepare(`INSERT INTO lead_activity (lead_id, kind, text) VALUES (?, 'note', ?)`).run(id, `Website loads now. ${reason}`);
    dead = false;
  });
  // No profiles linked from a website (or no website), so search for them by name. One Firecrawl search, cached for the day.
  if (FIRECRAWL_API_KEY && !Object.keys((check as { social?: object } | null)?.social ?? l.social_links).length) await step('Social profiles', async () => {
    const social = await findSocial(l.company_name, l.town);
    if (Object.keys(social).length) db.prepare('UPDATE leads SET social_links = ? WHERE id = ?').run(JSON.stringify(social), id);
  });
  if (site && !dead) {
    await step('PageSpeed', async () => { a.pagespeed = await pageSpeed(site); });
    await step('Domain age', async () => { a.domain = await domainAge(site); });
  }
  let html = '';
  if (site) await step('Screenshot', async () => {
    fs.mkdirSync(path.dirname(screenshotPath(id)), { recursive: true });
    html = await screenshotSite(site, screenshotPath(id));
    a.screenshot = true;
  });
  // Still stuck on the bot check, so Firecrawl takes the picture instead. If that fails too, the bot check picture stays.
  if (site && isChallenge(html) && FIRECRAWL_API_KEY) await step('Screenshot through Firecrawl', async () => { html = await scrapeShot(site, screenshotPath(id)); });
  // The page as the browser built it also catches sites that add their email with JavaScript.
  const email = site && !l.email && ((check as { email?: string | null } | null)?.email || findEmail(html));
  if (email) {
    db.prepare(`UPDATE leads SET email = ? WHERE id = ? AND email = ''`).run(email, id);
    db.prepare(`INSERT INTO lead_activity (lead_id, kind, text) VALUES (?, 'note', ?)`).run(id, `Found ${email} on the website`);
  }
  l = lead(id);
  if (l.source === 'places' && l.source_ref && GOOGLE_PLACES_API_KEY) await step('Business Profile', async () => { a.gbp = await businessProfile(l.source_ref); });
  else if (l.rating !== null) a.gbp = { rating: l.rating, reviews: l.reviews };

  let priority: string | null = null;
  await step('Claude', async () => {
    const g = a.gbp;
    const r = await runPrompt('lead-review', {
      company: l.company_name, industry: l.industry, town: l.town, reason: l.lead_reason, website: site && !dead ? site : site ? `${site} (did not load when found)` : 'none',
      website_issues: describe(l.website_issues), seo_issues: describe(l.seo_issues),
      pagespeed: a.pagespeed ? `${a.pagespeed.score}, largest content shows in ${a.pagespeed.lcp}` : 'not checked',
      domain_age: a.domain ? `${a.domain.registered} (${a.domain.years} years ago)` : 'not known',
      gbp: g ? `${g.rating ?? 'no'} stars from ${g.reviews ?? 0} reviews${g.has_hours === undefined ? '' : `, ${g.has_hours ? 'has' : 'no'} opening hours, ${g.photos} photos`}` : 'not found',
      social: Object.keys(l.social_links).join(', ') || 'none found',
    }, { job: 'lead:review' });
    priority = r.output.priority;
    a.notes = r.output.notes;
    a.pitch = r.output.pitch;
    a.cost_gbp = +r.cost_gbp.toFixed(4);
  });
  db.prepare(`UPDATE leads SET analysis = ?, priority = ?, analysed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
    .run(JSON.stringify(a), priority, id);
  return lead(id);
}

// Every lead in a campaign not yet analysed, one at a time in the background.
// `all` analyses every lead again, not just the new ones, to pick up changes to the sites or to the checks.
export function analyseCampaign(id: number, all = false) {
  if (busy()) fail(409, 'A campaign is already running or being analysed. Wait for it to finish.');
  const todo = db.prepare(`SELECT id, company_name FROM leads WHERE campaign_id = ? AND (? OR analysed_at IS NULL) AND status != 'archived' ORDER BY id`)
    .all(id, all ? 1 : 0) as { id: number; company_name: string }[];
  if (!todo.length) fail(400, 'Every lead in this campaign has been analysed already');
  const p = { done: 0, total: todo.length, current: '' };
  analysing.set(id, p);
  (async () => {
    try {
      for (const t of todo) {
        p.current = t.company_name;
        await analyseLead(t.id);
        p.done++;
      }
    } catch (err) {
      db.prepare('UPDATE campaigns SET last_run_summary = json_set(COALESCE(last_run_summary, \'{}\'), \'$.analysis_error\', ?) WHERE id = ?').run((err as Error).message, id);
    } finally { analysing.delete(id); }
  })();
  return p;
}
