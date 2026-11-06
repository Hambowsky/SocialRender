// Links: chances to earn backlinks, found once a day. Two kinds:
// * requests: journalists asking for expert comment (#journorequest), where a quote usually comes with a link;
// * mentions: pages that name Red Cherry IT without linking to redcherryit.com.
// Claude (Haiku) keeps the real ones and drafts what David could send. Nothing is ever sent from here.
import { db } from './db.ts';
import { fail, FIRECRAWL_API_KEY, SITE_URL } from './config.ts';
import { runPrompt } from './copy.ts';
import { firecrawlSearch } from './leads.ts';
import { fetchPage } from './page.ts';

type Link = { id: number; url: string; kind: 'request' | 'mention'; title: string; snippet: string; site: string; status: string; summary: string; deadline: string; reply: string; created_at: string };

const TOPICS = '(website OR websites OR "web design" OR SEO OR "digital marketing" OR "social media" OR ecommerce OR "small firms" OR "online presence")';
const QUERIES: [Link['kind'], string, string][] = [
  ['request', `#journorequest ${TOPICS} (site:x.com OR site:bsky.app OR site:threads.net)`, 'qdr:d'],
  ['request', `"journo request" OR "journorequest" ${TOPICS} UK`, 'qdr:d'],
  ['mention', `"Red Cherry IT" -site:redcherryit.com`, 'qdr:m'],
  ['mention', `"redcherryit" -site:redcherryit.com`, 'qdr:m'],
];
const host = (url: string) => new URL(url).hostname.replace(/^www\./, '');
const ownSite = host(SITE_URL);

// A mention only counts when the page does not link to us already. Read with a plain fetch (free); a page that will
// not load is kept, so David can look himself. fetchPage only reads public addresses.
async function linksToUs(url: string) {
  try {
    const { res } = await fetchPage(url);
    return res.ok && (await res.text()).slice(0, 2_000_000).includes(ownSite);
  } catch { return false; }
}

let scanning = false;
export async function scan() {
  if (!FIRECRAWL_API_KEY) fail(503, 'Links need FIRECRAWL_API_KEY for the web search');
  if (scanning) fail(409, 'A link search is already running');
  scanning = true;
  try {
    const hits = new Map<string, { kind: Link['kind']; title: string; snippet: string }>();
    for (const [kind, query, tbs] of QUERIES) {
      const data = await firecrawlSearch({ query, limit: 20, tbs, location: 'United Kingdom', country: 'GB' }, 'links');
      for (const r of data.data?.web ?? [])
        if (/^https?:\/\//.test(r.url) && !hits.has(r.url) && host(r.url) !== ownSite) hits.set(r.url, { kind, title: r.title ?? '', snippet: r.description ?? '' });
    }
    const known = db.prepare('SELECT 1 FROM links WHERE url = ?');
    const insert = db.prepare(`INSERT INTO links (url, kind, title, snippet, site, status, summary, deadline, reply) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (url) DO NOTHING`);
    const fresh: [string, { kind: Link['kind']; title: string; snippet: string }][] = [];
    for (const [url, h] of [...hits].filter(([url]) => !known.get(url)).slice(0, 60)) {
      if (h.kind === 'mention' && await linksToUs(url)) insert.run(url, h.kind, h.title, h.snippet, host(url), 'ignored', 'Already links to us', '', '');
      else fresh.push([url, h]);
    }
    let added = 0;
    if (fresh.length) {
      const posts = fresh.map(([url, h], i) => `${i + 1}. [${h.kind}] ${h.title}\n${h.snippet}\n${url}`).join('\n\n');
      const r = await runPrompt('link-review', { posts, site: SITE_URL }, { job: 'links:review' });
      const items = new Map((r.output as { items: { n: number; keep: boolean; summary: string; deadline: string; reply: string }[] }).items.map(i => [i.n, i]));
      fresh.forEach(([url, h], i) => {
        const it = items.get(i + 1), keep = !!it?.keep;
        insert.run(url, h.kind, h.title, h.snippet, host(url), keep ? 'new' : 'ignored', keep ? it!.summary : '', keep ? it!.deadline : '', keep ? it!.reply : '');
        if (keep) added++;
      });
    }
    db.prepare(`INSERT INTO settings (key, value) VALUES ('links_scanned_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(new Date().toISOString());
    return { searched: QUERIES.length, found: hits.size, checked: fresh.length, added };
  } finally {
    scanning = false;
  }
}

export function list(all = false) {
  return {
    links: db.prepare(`SELECT * FROM links WHERE status ${all ? "!= 'ignored'" : "= 'new'"} ORDER BY id DESC LIMIT 200`).all() as Link[],
    scanned_at: (db.prepare(`SELECT value FROM settings WHERE key = 'links_scanned_at'`).get() as { value: string } | undefined)?.value ?? null,
  };
}

// done: David answered or asked for the link. dismissed: not worth it. Both only from new, so a repeat click changes nothing.
export function mark(id: number, status: 'done' | 'dismissed') {
  db.prepare('SELECT 1 FROM links WHERE id = ?').get(id) ?? fail(404, 'No link with that id');
  db.prepare(`UPDATE links SET status = ? WHERE id = ? AND status = 'new'`).run(status, id);
  return db.prepare('SELECT * FROM links WHERE id = ?').get(id) as Link;
}

// Once a day while the server runs, an hour after the signal search would start, so the two do not overlap.
export function startLinks() {
  if (!FIRECRAWL_API_KEY || !process.env.ANTHROPIC_API_KEY) return;
  const due = () => {
    const at = list().scanned_at;
    if (!at || Date.now() - Date.parse(at) > 23 * 3600_000) scan().catch(err => console.error('Link search failed:', err.message));
  };
  setTimeout(due, 5 * 60_000).unref();
  setInterval(due, 3600_000).unref();
}
