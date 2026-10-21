// Phase 3 of Sales: a closer look at each lead. PageSpeed, domain age, Business Profile and a screenshot are plain
// lookups; Claude then reads them and gives a priority, a note on why, and an opening line for David.
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.ts';
import { fail, GOOGLE_PLACES_API_KEY, GOOGLE_PLACES_URL, PAGESPEED_URL, RDAP_URL } from './config.ts';
import { analysing, busy, cached, lead, screenshotPath } from './leads.ts';
import { screenshotSite } from './render.ts';
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
  const json = await getJson(`${RDAP_URL}/domain/${encodeURIComponent(domain)}`, { headers: { accept: 'application/rdap+json' } });
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
  const l = lead(id) as any;
  const a: Analysis = { errors: [] };
  const step = async (name: string, work: () => Promise<void>) => {
    try { await work(); } catch (err) {
      if ((err as any).statusCode === 402) throw err; // the monthly AI cap: stop, rather than note it on every lead
      a.errors.push(`${name}: ${(err as Error).message}`);
    }
  };
  const site = l.website_url && !l.lead_reason.startsWith('Website listed but unreachable') ? l.website_url : '';
  if (site) {
    await step('PageSpeed', async () => { a.pagespeed = await pageSpeed(site); });
    await step('Domain age', async () => { a.domain = await domainAge(site); });
    await step('Screenshot', async () => {
      fs.mkdirSync(path.dirname(screenshotPath(id)), { recursive: true });
      await screenshotSite(site, screenshotPath(id));
      a.screenshot = true;
    });
  }
  if (l.source === 'places' && l.source_ref && GOOGLE_PLACES_API_KEY) await step('Business Profile', async () => { a.gbp = await businessProfile(l.source_ref); });
  else if (l.rating !== null) a.gbp = { rating: l.rating, reviews: l.reviews };

  let priority: string | null = null;
  await step('Claude', async () => {
    const g = a.gbp;
    const r = await runPrompt('lead-review', {
      company: l.company_name, industry: l.industry, town: l.town, reason: l.lead_reason, website: site || 'none',
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
export function analyseCampaign(id: number) {
  if (busy()) fail(409, 'A campaign is already running or being analysed. Wait for it to finish.');
  const todo = db.prepare(`SELECT id, company_name FROM leads WHERE campaign_id = ? AND analysed_at IS NULL AND status != 'archived' ORDER BY id`).all(id) as { id: number; company_name: string }[];
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
