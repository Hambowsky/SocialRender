// Sales: campaigns find local businesses with no website or a weak one, and keep them as leads to follow up.
// Searching costs money per call, so every answer is cached for a day and calls are capped per month.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.ts';
import { DATA_DIR, fail, GBP_PER_USD, FIRECRAWL_API_KEY, FIRECRAWL_API_URL, GOOGLE_PLACES_API_KEY, GOOGLE_PLACES_URL } from './config.ts';
import { checkSite, type SiteCheck } from './sitecheck.ts';

export const screenshotPath = (id: number) => path.join(DATA_DIR, 'leads', `${id}.jpg`);

export const LEAD_TYPES = ['no_website', 'outdated_website', 'both'] as const;
export const SOURCES = ['places', 'directories'] as const;
export const STATUSES = ['new', 'contacted', 'replied', 'bounced', 'converted', 'not_interested', 'not_a_fit', 'archived'] as const;
// Google gives 1,000 Text Search calls with phone and website free each month; stay under that unless told otherwise.
// Town suggestions are a cheaper Google product with 10,000 free a month; half of that is plenty for typing.
const MONTHLY_CALLS = { places: Number(process.env.PLACES_MONTHLY_CALLS || 900), firecrawl: Number(process.env.FIRECRAWL_MONTHLY_CALLS || 500), towns: 5000,
  scrape: Number(process.env.FIRECRAWL_SCRAPE_MONTHLY_CALLS || 1000) };
type Api = keyof typeof MONTHLY_CALLS;
// Google's price for Text Search with phone and website (Enterprise), after the first 1,000 free each month.
const GOOGLE_FREE = 1000, GOOGLE_USD_EACH = 0.035;
const MAX_COMBOS = 25;
const DIRECTORIES = ['yell.com', 'freeindex.co.uk', 'scoot.co.uk', 'checkatrade.com', 'ratedpeople.com', 'mybuilder.com', 'facebook.com/pages', 'linkedin.com/company'];

export type CampaignInput = { name: string; industries: string; towns: string; lead_type: typeof LEAD_TYPES[number]; max_leads: number; sources: string[] };
type Campaign = Omit<CampaignInput, 'sources'> & { id: number; sources: string; status: string; last_run_at: string | null; last_run_summary: string | null };
type Found = { company_name: string; phone: string; email: string; website_url: string; address: string; postcode: string; town: string;
  industry: string; source: string; source_ref: string; rating: number | null; reviews: number | null };
type Progress = { stage: string; found: number; checked: number; added: number; duplicates: number; not_matching: number;
  google_searches?: number; google_cost_gbp?: number; firecrawl_searches?: number; firecrawl_credits?: number };

const list_ = (s: string) => [...new Set(s.split(',').map(x => x.trim()).filter(Boolean))];

// A run in progress when the app stopped will never finish, so say so rather than show it running forever.
db.prepare(`UPDATE campaigns SET status = 'failed', last_run_summary = ? WHERE status = 'running'`)
  .run(JSON.stringify({ error: 'The app restarted during this run. Run it again: businesses already added are skipped.' }));

const running = new Map<number, Progress>();
// Lead analysis runs (src/analyse.ts) keep their progress here, so campaigns can show it.
export const analysing = new Map<number, { done: number; total: number; current: string }>();
export const busy = () => running.size > 0 || analysing.size > 0;

function view(c: Campaign) {
  const leads = (db.prepare('SELECT COUNT(*) AS n FROM leads WHERE campaign_id = ?').get(c.id) as { n: number }).n;
  const analysed = (db.prepare('SELECT COUNT(*) AS n FROM leads WHERE campaign_id = ? AND analysed_at IS NOT NULL').get(c.id) as { n: number }).n;
  return { ...c, sources: c.sources.split(','), last_run_summary: c.last_run_summary ? JSON.parse(c.last_run_summary) : null, leads, analysed,
    progress: running.get(c.id) ?? null, analysis_progress: analysing.get(c.id) ?? null };
}
const getRow = (id: number) => (db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id) as Campaign | undefined) ?? fail(404, 'No campaign with that id');

function validate(c: CampaignInput) {
  const combos = list_(c.industries).length * list_(c.towns).length;
  if (!combos) fail(400, 'Add at least one industry and one town');
  if (combos > MAX_COMBOS) fail(400, `That is ${combos} industry and town searches. Keep it to ${MAX_COMBOS} or fewer per campaign.`);
}

export const campaigns = () => (db.prepare('SELECT * FROM campaigns ORDER BY id DESC').all() as Campaign[]).map(view);
export const campaign = (id: number) => view(getRow(id));

export function createCampaign(c: CampaignInput) {
  validate(c);
  const { lastInsertRowid } = db.prepare('INSERT INTO campaigns (name, industries, towns, lead_type, max_leads, sources) VALUES (?, ?, ?, ?, ?, ?)')
    .run(c.name.trim(), list_(c.industries).join(', '), list_(c.towns).join(', '), c.lead_type, c.max_leads, c.sources.join(','));
  return campaign(Number(lastInsertRowid));
}

export function updateCampaign(id: number, c: CampaignInput) {
  getRow(id);
  if (running.has(id)) fail(409, 'Wait for this campaign to finish running before changing it');
  validate(c);
  db.prepare('UPDATE campaigns SET name = ?, industries = ?, towns = ?, lead_type = ?, max_leads = ?, sources = ? WHERE id = ?')
    .run(c.name.trim(), list_(c.industries).join(', '), list_(c.towns).join(', '), c.lead_type, c.max_leads, c.sources.join(','), id);
  return campaign(id);
}

// Leads nobody has touched go with the campaign. Ones already worked on stay, without a campaign.
export function deleteCampaign(id: number) {
  getRow(id);
  if (running.has(id)) fail(409, 'Wait for this campaign to finish running before deleting it');
  if (analysing.has(id)) fail(409, 'Wait for this campaign\'s leads to finish being analysed before deleting it');
  const gone = db.prepare(`SELECT id FROM leads WHERE campaign_id = ? AND status = 'new'`).all(id) as { id: number }[];
  for (const l of gone) fs.rmSync(screenshotPath(l.id), { force: true });
  const { changes } = db.prepare(`DELETE FROM leads WHERE campaign_id = ? AND status = 'new'`).run(id);
  db.prepare('DELETE FROM campaigns WHERE id = ?').run(id);
  return { deleted: true, leads_removed: changes };
}

// ---- Searching ----

// What searching has used this calendar month: Google calls against its free 1,000, and Firecrawl credits (they bill by credit).
export function usage() {
  // Credits cover searches and the page reads used when the server cannot load a site itself.
  const firecrawl = db.prepare(`SELECT COALESCE(SUM(key LIKE 'firecrawl:%'), 0) AS calls, COALESCE(SUM(json_extract(body, '$.creditsUsed')), 0) AS credits FROM api_cache
    WHERE (key LIKE 'firecrawl:%' OR key LIKE 'scrape:%') AND created_at >= datetime('now', 'start of month')`).get() as { calls: number; credits: number };
  const google = used('places');
  return { google_searches: google, google_free: GOOGLE_FREE, google_cost_gbp: googleCost(0, google), firecrawl_searches: firecrawl.calls, firecrawl_credits: firecrawl.credits };
}
// Cost of the Google calls between two month counts, counting only those past the free allowance.
const googleCost = (from: number, to: number) => +(Math.max(0, to - Math.max(from, GOOGLE_FREE)) * GOOGLE_USD_EACH * GBP_PER_USD).toFixed(2);

function used(api: Api) {
  return (db.prepare(`SELECT COUNT(*) AS n FROM api_cache WHERE key LIKE ? AND created_at >= datetime('now', 'start of month')`).get(`${api}:%`) as { n: number }).n;
}

// One row per paid call: the key carries the day, so answers are reused until midnight (UTC) and every call is counted.
export async function cached<T>(api: Api, request: unknown, call: () => Promise<T>): Promise<T> {
  const key = `${api}:${new Date().toISOString().slice(0, 10)}:${crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex')}`;
  const hit = db.prepare('SELECT body FROM api_cache WHERE key = ?').get(key) as { body: string } | undefined;
  if (hit) return JSON.parse(hit.body);
  if (used(api) >= MONTHLY_CALLS[api]) fail(429, `The monthly limit of ${MONTHLY_CALLS[api]} ${{ places: 'Google Places searches', firecrawl: 'Firecrawl searches', towns: 'town suggestions', scrape: 'Firecrawl page reads' }[api]} is used up`);
  const body = await call();
  db.prepare(`INSERT INTO api_cache (key, body) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET body = excluded.body, created_at = datetime('now')`).run(key, JSON.stringify(body));
  return body;
}

type Place = { id: string; displayName?: { text: string }; formattedAddress?: string; nationalPhoneNumber?: string; websiteUri?: string;
  businessStatus?: string; rating?: number; userRatingCount?: number; addressComponents?: { longText?: string; types?: string[] }[] };
const PLACE_FIELDS = ['id', 'displayName', 'formattedAddress', 'addressComponents', 'nationalPhoneNumber', 'websiteUri', 'businessStatus', 'rating', 'userRatingCount']
  .map(f => `places.${f}`).concat('nextPageToken').join(',');

async function places(industry: string, town: string, want: number): Promise<Found[]> {
  const out: Found[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 3 && out.length < want; page++) {
    const req = { textQuery: `${industry} in ${town}, UK`, regionCode: 'gb', pageSize: 20, ...(pageToken && { pageToken }) };
    const data = await cached('places', req, async () => {
      const res = await fetch(`${GOOGLE_PLACES_URL}/v1/places:searchText`, { method: 'POST', signal: AbortSignal.timeout(20_000),
        headers: { 'content-type': 'application/json', 'x-goog-api-key': GOOGLE_PLACES_API_KEY, 'x-goog-fieldmask': PLACE_FIELDS }, body: JSON.stringify(req) });
      const json = await res.json().catch(() => ({})) as { places?: Place[]; nextPageToken?: string; error?: { message: string } };
      if (!res.ok) fail(502, `Google Places said: ${json.error?.message ?? res.status}`);
      return json;
    });
    for (const p of data.places ?? []) {
      if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') continue;
      const part = (t: string) => p.addressComponents?.find(c => c.types?.includes(t))?.longText ?? '';
      out.push({ company_name: p.displayName?.text ?? '', phone: p.nationalPhoneNumber ?? '', email: '', website_url: p.websiteUri ?? '',
        address: p.formattedAddress ?? '', postcode: part('postal_code'), town: part('postal_town') || part('locality') || town, industry,
        source: 'places', source_ref: p.id, rating: p.rating ?? null, reviews: p.userRatingCount ?? null });
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

// UK towns and cities as you type, so a campaign searches a real place. Google's error is passed on so a bad key is easy to spot.
export async function towns(q: string): Promise<{ name: string; area: string }[]> {
  if (!GOOGLE_PLACES_API_KEY || q.trim().length < 2) return [];
  const req = { input: q.trim().toLowerCase(), includedRegionCodes: ['gb'], includedPrimaryTypes: ['locality', 'postal_town'] };
  type Prediction = { placePrediction?: { structuredFormat?: { mainText?: { text: string }; secondaryText?: { text: string } } } };
  const data = await cached('towns', req, async () => {
    const res = await fetch(`${GOOGLE_PLACES_URL}/v1/places:autocomplete`, { method: 'POST', signal: AbortSignal.timeout(8_000),
      headers: { 'content-type': 'application/json', 'x-goog-api-key': GOOGLE_PLACES_API_KEY }, body: JSON.stringify(req) });
    const json = await res.json().catch(() => ({})) as { suggestions?: Prediction[]; error?: { message: string } };
    if (!res.ok) fail(502, `Google said: ${json.error?.message ?? res.status}`);
    return json;
  });
  // The main text never has a comma, which matters because towns are stored as a comma separated list.
  return (data.suggestions ?? []).flatMap(s => {
    const f = s.placePrediction?.structuredFormat;
    return f?.mainText?.text ? [{ name: f.mainText.text, area: f.secondaryText?.text ?? '' }] : [];
  });
}

type Hit = { title?: string; description?: string; url: string };
export const firecrawlSearch = (req: object) => cached('firecrawl', req, async () => {
  const res = await fetch(`${FIRECRAWL_API_URL}/v2/search`, { method: 'POST', signal: AbortSignal.timeout(30_000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${FIRECRAWL_API_KEY}` }, body: JSON.stringify(req) });
  const json = await res.json().catch(() => ({})) as { data?: { web?: Hit[] }; error?: string };
  if (!res.ok) fail(502, `Firecrawl said: ${json.error ?? res.status}`);
  return json;
});

// Directory listings are businesses that advertise somewhere other than their own site: a strong no website signal.
async function directories(industry: string, town: string, want: number): Promise<Found[]> {
  const limit = Math.min(20, Math.max(5, Math.ceil(want / DIRECTORIES.length)));
  const out: Found[] = [];
  for (const site of DIRECTORIES) {
    const req = { query: `${industry} ${town} site:${site}`, limit, location: 'United Kingdom', country: 'GB' };
    const data = await firecrawlSearch(req);
    for (const r of data.data?.web ?? []) {
      const name = (r.title ?? '').replace(/\s*[-|–].*(yell|freeindex|scoot|checkatrade|rated ?people|my ?builder|facebook|linkedin).*/i, '').trim();
      if (!name) continue;
      const text = r.description ?? '';
      out.push({ company_name: name, phone: text.match(/(\+?44\s?7\d{3}|\(?0\d{2,4}\)?)[\s-]?\d{3,4}[\s-]?\d{3,4}/)?.[0] ?? '',
        email: text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0].toLowerCase() ?? '', website_url: '', address: '', postcode: '',
        town, industry, source: site.split('/')[0], source_ref: r.url, rating: null, reviews: null });
    }
  }
  return out;
}

// Name and town, not postcode: directory listings rarely give a postcode, and the same business must match across sources.
export function dedupKey(name: string, place: string) {
  const norm = name.toLowerCase().replace(/\b(ltd|limited|llp|plc|inc|the|co)\b/g, '').replace(/[^a-z0-9]/g, '');
  return crypto.createHash('sha256').update(`${norm}|${place.toLowerCase().replace(/\s/g, '')}`).digest('hex').slice(0, 40);
}

// Whether a business fits the campaign, and the reason shown on the lead.
export function judge(f: Found, site: SiteCheck | null, type: Campaign['lead_type']) {
  if (!f.website_url) return type !== 'outdated_website' ? 'No website found for this business' : null;
  if (!site?.reachable) return type !== 'outdated_website' ? 'Website listed but unreachable' : null;
  const issues = Object.keys(site.issues);
  return issues.length && type !== 'no_website' ? `Outdated website: ${issues.join(', ')}` : null;
}

async function work(c: Campaign, p: Progress) {
  const industries = list_(c.industries), towns = list_(c.towns), sources = c.sources.split(',');
  const perCombo = Math.ceil(c.max_leads / (industries.length * towns.length));
  const insert = db.prepare(`INSERT INTO leads (campaign_id, dedup_key, company_name, phone, email, website_url, address, postcode, town, industry,
      source, source_ref, has_website, website_issues, seo_issues, social_links, rating, reviews, lead_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (dedup_key) DO NOTHING`);
  const known = db.prepare('SELECT 1 FROM leads WHERE dedup_key = ?');

  for (const industry of industries) for (const town of towns) {
    if (p.added >= c.max_leads) return;
    p.stage = `Searching for ${industry} in ${town}`;
    // Over fetch, since many results will not fit or are already leads.
    const found = [
      ...sources.includes('places') ? await places(industry, town, perCombo * 2) : [],
      ...sources.includes('directories') ? await directories(industry, town, perCombo * 2) : [],
    ];
    p.found += found.length;
    const seen = new Set<string>();
    const fresh = found.filter(f => {
      const key = dedupKey(f.company_name, f.town);
      if (seen.has(key) || known.get(key)) { p.duplicates++; return false; }
      seen.add(key);
      return true;
    });
    p.stage = `Checking websites for ${industry} in ${town}`;
    // ponytail: four checks at a time in fixed batches; a pool would be quicker when one site is slow.
    for (let i = 0; i < fresh.length && p.added < c.max_leads; i += 4) {
      const batch = fresh.slice(i, i + 4);
      const sites = await Promise.all(batch.map(f => f.website_url ? checkSite(f.website_url) : null));
      batch.forEach((f, j) => {
        const site = sites[j];
        if (site) p.checked++;
        const reason = judge(f, site, c.lead_type);
        if (!reason || p.added >= c.max_leads) return void (reason || p.not_matching++);
        const r = insert.run(c.id, dedupKey(f.company_name, f.town), f.company_name, f.phone, f.email || site?.email || '',
          site?.url ?? f.website_url, f.address, f.postcode, f.town, f.industry, f.source, f.source_ref, f.website_url ? 1 : 0,
          JSON.stringify(site?.issues ?? {}), JSON.stringify(site?.seo ?? {}), JSON.stringify(site?.social ?? {}), f.rating, f.reviews,
          site?.note ? `${reason}. ${site.note}` : reason);
        if (r.changes) p.added++; else p.duplicates++;
      });
    }
  }
}

export function run(id: number) {
  const c = getRow(id);
  if (busy()) fail(409, running.has(id) ? 'This campaign is already running' : 'Another campaign is running or being analysed. Wait for it to finish.');
  const sources = c.sources.split(',');
  if (sources.includes('places') && !GOOGLE_PLACES_API_KEY) fail(503, 'Google Maps search is not set up: add GOOGLE_PLACES_API_KEY');
  if (sources.includes('directories') && !FIRECRAWL_API_KEY) fail(503, 'Directory search is not set up: add FIRECRAWL_API_KEY');
  const p: Progress = { stage: 'Starting', found: 0, checked: 0, added: 0, duplicates: 0, not_matching: 0 };
  running.set(id, p);
  db.prepare(`UPDATE campaigns SET status = 'running', last_run_at = datetime('now') WHERE id = ?`).run(id);
  const finish = (status: string, summary: object) => {
    db.prepare('UPDATE campaigns SET status = ?, last_run_summary = ? WHERE id = ?').run(status, JSON.stringify(summary), id);
    running.delete(id);
  };
  // Searches answered from the cache cost nothing, so the run's cost is the change in this month's counts.
  const before = usage();
  const spent = () => {
    const after = usage();
    return { google_searches: after.google_searches - before.google_searches, google_cost_gbp: googleCost(before.google_searches, after.google_searches),
      firecrawl_searches: after.firecrawl_searches - before.firecrawl_searches, firecrawl_credits: after.firecrawl_credits - before.firecrawl_credits };
  };
  work(c, p).then(() => finish('done', { ...p, ...spent(), stage: undefined }), err => finish('failed', { ...p, ...spent(), stage: undefined, error: (err as Error).message }));
  return campaign(id);
}

// ---- Leads ----

const LEAD_LIST = `SELECT l.id, l.company_name, l.phone, l.email, l.website_url, l.town, l.industry, l.source, l.has_website, l.lead_reason,
  l.status, l.follow_up_date, l.rating, l.reviews, l.priority, l.analysed_at, l.created_at, l.campaign_id, c.name AS campaign FROM leads l LEFT JOIN campaigns c ON c.id = l.campaign_id`;

const INACTIVE = `('not_interested', 'not_a_fit', 'archived')`;
const HAS = { website: 'l.has_website = 1', email: `l.email != ''`, phone: `l.phone != ''` };
const SORTS: Record<string, string> = { newest: 'l.id DESC', priority: `CASE l.priority WHEN 'hot' THEN 0 WHEN 'warm' THEN 1 WHEN 'cold' THEN 2 ELSE 3 END, l.id DESC`,
  name: 'l.company_name COLLATE NOCASE', town: 'l.town COLLATE NOCASE, l.company_name COLLATE NOCASE' };
export type LeadFilter = { campaign?: number; status?: string; priority?: string; search?: string; sort?: string } & Partial<Record<`has_${keyof typeof HAS}`, 'yes' | 'no'>>;

// Same filters as the old tool: status (active hides the dead ones, contacted_plus is anything past new), priority, search,
// and yes/no on whether a lead has a website, an email or a phone number.
export function leads(q: LeadFilter) {
  const where: string[] = [], args: (string | number)[] = [];
  if (q.campaign) { where.push('l.campaign_id = ?'); args.push(q.campaign); }
  if (q.status === 'active') where.push(`l.status NOT IN ${INACTIVE}`);
  else if (q.status === 'contacted_plus') where.push(`l.status IN ('contacted', 'replied', 'converted', 'bounced')`);
  else if (q.status) { where.push('l.status = ?'); args.push(q.status); }
  if (q.priority) { where.push('l.priority = ?'); args.push(q.priority); }
  for (const [k, sql] of Object.entries(HAS)) {
    const v = q[`has_${k}` as keyof LeadFilter];
    if (v === 'yes') where.push(sql); else if (v === 'no') where.push(`NOT (${sql})`);
  }
  if (q.search) { where.push('(l.company_name LIKE ? OR l.town LIKE ? OR l.industry LIKE ? OR l.email LIKE ?)'); args.push(...Array(4).fill(`%${q.search}%`)); }
  // ponytail: first 500 only; add paging when the list outgrows that.
  return db.prepare(`${LEAD_LIST}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${SORTS[q.sort ?? ''] ?? SORTS.newest} LIMIT 500`).all(...args);
}
export const LEAD_SORTS = Object.keys(SORTS);

export function lead(id: number) {
  const l = db.prepare('SELECT l.*, c.name AS campaign FROM leads l LEFT JOIN campaigns c ON c.id = l.campaign_id WHERE l.id = ?').get(id) as Record<string, unknown> | undefined;
  if (!l) fail(404, 'No lead with that id');
  for (const k of ['website_issues', 'seo_issues', 'social_links', 'analysis']) l![k] = JSON.parse(String(l![k]));
  return { ...l!, activity: db.prepare('SELECT kind, text, created_at FROM lead_activity WHERE lead_id = ? ORDER BY id DESC').all(id) };
}

export type LeadChange = Partial<Record<'company_name' | 'contact_name' | 'phone' | 'email' | 'website_url' | 'status', string>> & { follow_up_date?: string | null };

export function updateLead(id: number, change: LeadChange) {
  const before = lead(id) as Record<string, unknown>;
  const keys = Object.keys(change) as (keyof LeadChange)[];
  if (keys.length) {
    db.prepare(`UPDATE leads SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...keys.map(k => change[k] ?? null), id);
  }
  if (change.status && change.status !== before.status)
    db.prepare(`INSERT INTO lead_activity (lead_id, kind, text) VALUES (?, 'status', ?)`).run(id, `Status changed from ${before.status} to ${change.status}`);
  return lead(id);
}

export function addNote(id: number, text: string) {
  lead(id);
  db.prepare(`INSERT INTO lead_activity (lead_id, kind, text) VALUES (?, 'note', ?)`).run(id, text.trim());
  db.prepare(`UPDATE leads SET updated_at = datetime('now') WHERE id = ?`).run(id);
  return lead(id);
}
