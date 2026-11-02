// Signals: public posts from people asking for a web designer, developer or SEO help, found once a day.
// A web search finds recent posts, Claude (Haiku) keeps the real requests and suggests a reply, and David answers them himself.
// Nothing is ever posted from here.
import { db } from './db.ts';
import { fail, FIRECRAWL_API_KEY } from './config.ts';
import { runPrompt } from './copy.ts';
import { addNote, dedupKey, firecrawlSearch } from './leads.ts';

type Signal = { id: number; url: string; title: string; snippet: string; site: string; status: string; service: string; area: string; who: string; summary: string; reply: string; lead_id: number | null; created_at: string };

const SITES = '(site:reddit.com OR site:x.com OR site:threads.net OR site:ukbusinessforums.co.uk OR site:mumsnet.com)';
const ASK = '("web designer" OR "website designer" OR "web developer" OR "SEO" OR "new website") (recommend OR recommendations OR "looking for" OR "need")';

// The towns in David's campaigns, so the search covers where he works.
export function towns() {
  const all = (db.prepare('SELECT towns FROM campaigns ORDER BY id DESC').all() as { towns: string }[]).flatMap(c => c.towns.split(',').map(t => t.trim()).filter(Boolean));
  const unique = [...new Map(all.map(t => [t.toLowerCase(), t])).values()].slice(0, 5);
  return unique.length ? unique : ['Newcastle upon Tyne', 'Durham', 'Sunderland'];
}

let scanning = false;
export async function scan() {
  if (!FIRECRAWL_API_KEY) fail(503, 'Signals need FIRECRAWL_API_KEY for the web search');
  if (scanning) fail(409, 'A signal search is already running');
  scanning = true;
  try {
    const places = towns();
    // One search per town plus one for the UK, limited to the past week.
    const queries = [...places.map(t => `${ASK} "${t}" ${SITES}`), `${ASK} UK small business ${SITES}`];
    const hits = new Map<string, { title: string; snippet: string }>();
    for (const query of queries) {
      const data = await firecrawlSearch({ query, limit: 20, tbs: 'qdr:w', location: 'United Kingdom', country: 'GB' }, 'signals');
      for (const r of data.data?.web ?? []) if (/^https?:\/\//.test(r.url) && !hits.has(r.url)) hits.set(r.url, { title: r.title ?? '', snippet: r.description ?? '' });
    }
    const known = db.prepare('SELECT 1 FROM signals WHERE url = ?');
    const fresh = [...hits].filter(([url]) => !known.get(url)).slice(0, 60);
    let added = 0;
    if (fresh.length) {
      const posts = fresh.map(([url, h], i) => `${i + 1}. ${h.title}\n${h.snippet}\n${url}`).join('\n\n');
      const r = await runPrompt('signal-review', { towns: places.join(', '), posts }, { job: 'lead:signals' });
      const items = new Map((r.output as { items: { n: number; genuine: boolean; service: string; area: string; who: string; summary: string; reply: string }[] }).items.map(i => [i.n, i]));
      const insert = db.prepare(`INSERT INTO signals (url, title, snippet, site, status, service, area, who, summary, reply) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (url) DO NOTHING`);
      fresh.forEach(([url, h], i) => {
        const it = items.get(i + 1);
        const keep = !!it?.genuine;
        insert.run(url, h.title, h.snippet, new URL(url).hostname.replace(/^www\./, ''), keep ? 'new' : 'ignored',
          keep ? it!.service : '', keep ? it!.area : '', keep ? it!.who : '', keep ? it!.summary : '', keep ? it!.reply : '');
        if (keep) added++;
      });
    }
    db.prepare(`INSERT INTO settings (key, value) VALUES ('signals_scanned_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(new Date().toISOString());
    return { searched: queries.length, found: hits.size, checked: fresh.length, added };
  } finally {
    scanning = false;
  }
}

export function list(all = false) {
  return {
    signals: db.prepare(`SELECT * FROM signals WHERE status ${all ? "!= 'ignored'" : "= 'new'"} ORDER BY id DESC LIMIT 200`).all() as Signal[],
    scanned_at: (db.prepare(`SELECT value FROM settings WHERE key = 'signals_scanned_at'`).get() as { value: string } | undefined)?.value ?? null,
    towns: towns(),
  };
}

function get(id: number) {
  return (db.prepare('SELECT * FROM signals WHERE id = ?').get(id) as Signal | undefined) ?? fail(404, 'No signal with that id');
}

export function dismiss(id: number) {
  get(id);
  db.prepare(`UPDATE signals SET status = 'dismissed' WHERE id = ? AND status = 'new'`).run(id);
  return get(id);
}

// Saves the person as a lead so they sit with the rest of Sales. Done once: a second click returns the same lead.
export function toLead(id: number) {
  const s = get(id);
  if (s.lead_id) return { signal: s, lead_id: s.lead_id };
  const r = db.prepare(`INSERT INTO leads (dedup_key, company_name, town, industry, source, source_ref, has_website, lead_reason)
    VALUES (?, ?, ?, ?, 'signal', ?, 0, ?) ON CONFLICT (dedup_key) DO NOTHING`)
    .run(dedupKey(s.url, 'signal'), s.who || `${s.site} post`, s.area, s.service, s.url, s.summary || s.title);
  const leadId = r.changes ? Number(r.lastInsertRowid) : (db.prepare('SELECT id FROM leads WHERE dedup_key = ?').get(dedupKey(s.url, 'signal')) as { id: number }).id;
  if (r.changes) addNote(leadId, `Found asking for help on ${s.site}: ${s.url}${s.reply ? `\n\nSuggested reply: ${s.reply}` : ''}`);
  db.prepare(`UPDATE signals SET status = 'lead', lead_id = ? WHERE id = ?`).run(leadId, id);
  return { signal: get(id), lead_id: leadId };
}

// Once a day, while the server runs. A failed search is tried again the next hour.
export function startSignals() {
  if (!FIRECRAWL_API_KEY || !process.env.ANTHROPIC_API_KEY) return;
  const due = () => {
    const at = list().scanned_at;
    if (!at || Date.now() - Date.parse(at) > 23 * 3600_000) scan().catch(err => console.error('Signal search failed:', err.message));
  };
  setTimeout(due, 60_000).unref();
  setInterval(due, 3600_000).unref();
}
