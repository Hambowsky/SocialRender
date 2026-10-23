// Checks a business's website for the things that make it a lead: missing SSL, not mobile friendly, an old
// copyright year, and basic SEO gaps. Also picks up a contact email and social links. Plain code, no AI.
import fs from 'node:fs';
import { fetchPage, isChallenge } from './page.ts';
import { fail, FIRECRAWL_API_KEY, FIRECRAWL_API_URL } from './config.ts';
import { cached, firecrawlSearch } from './leads.ts';

export type SiteCheck = {
  reachable: boolean;
  url: string;
  issues: Record<string, unknown>;      // website problems that make it outdated
  seo: Record<string, unknown>;         // SEO gaps, shown on the lead
  email: string | null;
  social: Record<string, string>;
  note?: string;
};


type Page = { ok: boolean; status: number; url: string; html: string; error: string; firecrawl?: boolean };

async function load(url: string): Promise<Page> {
  let page: Page;
  try {
    const { url: final, res } = await fetchPage(url);
    const html = (await res.text()).slice(0, 2_000_000);
    page = { ok: res.ok, status: res.status, url: final.href, html, error: '' };
  } catch (err) { page = { ok: false, status: 0, url, html: '', error: (err as Error).message.replace(/^Could not load that page: /, '') }; }
  // Some sites will not answer this server (they block cloud servers, or the network drops them), so Firecrawl reads those for us.
  const blocked = page.error ? !/private address|not a valid|must start/.test(page.error) : page.status === 403 || isChallenge(page.html);
  if (blocked && FIRECRAWL_API_KEY) return scrape(url).catch(err => page.error
    ? { ...page, error: `${why(page.error)}. Firecrawl could not read it either: ${(err as Error).message}` } : page);
  return page;
}

async function firecrawl(body: object) {
  const res = await fetch(`${FIRECRAWL_API_URL}/v2/scrape`, { method: 'POST', signal: AbortSignal.timeout(60_000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${FIRECRAWL_API_KEY}` }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({})) as { error?: string; data?: { rawHtml?: string; screenshot?: string; metadata?: { statusCode?: number; url?: string; creditsUsed?: number } } };
  const d = json.data;
  if (!res.ok || !d?.rawHtml) fail(502, json.error ?? `error ${res.status}`); // not cached, so not counted
  // Scripts are dropped to keep the cache small; nothing the checks look for is inside them.
  return { creditsUsed: d!.metadata?.creditsUsed ?? 1, status: d!.metadata?.statusCode ?? res.status, url: d!.metadata?.url,
    html: d!.rawHtml!.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').slice(0, 500_000), screenshot: d!.screenshot };
}

export async function scrape(url: string): Promise<Page> {
  const r = await cached('scrape', { url }, async () => { const { screenshot, ...rest } = await firecrawl({ url, formats: ['rawHtml'] }); return rest; });
  return { ok: r.status < 400, status: r.status, url: r.url ?? url, html: r.html, error: '', firecrawl: true };
}

// A screenshot taken by Firecrawl, for sites whose bot check will not let this server's browser in. Returns the page HTML.
export async function scrapeShot(url: string, file: string) {
  // The key is never reused (the picture is saved here, not in the cache), but the call still counts towards the monthly cap.
  const r = await cached('scrape', { url, screenshot: Date.now() }, async () => {
    const { screenshot, ...rest } = await firecrawl({ url, formats: ['rawHtml', { type: 'screenshot', quality: 70, viewport: { width: 1280, height: 800 } }] });
    const img = screenshot ? await fetch(screenshot, { signal: AbortSignal.timeout(30_000) }) : null;
    if (!img?.ok) fail(502, `the screenshot did not come back${img ? ` (error ${img.status})` : ''}`);
    fs.writeFileSync(file, Buffer.from(await img!.arrayBuffer()));
    return rest;
  });
  if (isChallenge(r.html)) fail(502, 'it hit the same security check');
  return r.html;
}
// Why a page would not load, in words David can act on.
const why = (msg: string) => msg.includes('Firecrawl') ? msg : /timeout|aborted/i.test(msg) ? 'It took over 15 seconds to answer'
  : /could not find|ENOTFOUND/i.test(msg) ? 'Its address does not exist' : /cert|ssl|tls/i.test(msg) ? 'Its security certificate is broken' : `Error: ${msg}`;

// Cloudflare hides emails as hex, XORed with the first byte.
const cfDecode = (hex: string) => { const k = parseInt(hex.slice(0, 2), 16); let out = '';
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ k); return out; };

// Undoes the usual ways sites hide an address from bots: Cloudflare protection, &#64; style entities, %40, and "name [at] site [dot] com".
function unhide(html: string) {
  return html
    .replace(/data-cfemail=["']([0-9a-f]+)["']|\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/gi, (_, a, b) => ` ${cfDecode(a ?? b)} `)
    .replace(/&#(x?)([0-9a-f]+);/gi, (m, x, n) => { const c = parseInt(n, x ? 16 : 10); return c < 128 ? String.fromCharCode(c) : m; })
    .replace(/%40/g, '@')
    .replace(/\s*[\[({]\s*at\s*[\])}]\s*/gi, '@').replace(/\s*[\[({]\s*dot\s*[\])}]\s*/gi, '.');
}

export function findEmail(raw: string) {
  const html = unhide(raw);
  const mailto = html.match(/mailto:([^"'?&\s<>]+)/i)?.[1];
  if (mailto) {
    try { const e = decodeURIComponent(mailto).toLowerCase(); if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e)) return e; } catch { /* bad escape, try the text */ }
  }
  for (const m of html.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) {
    const e = m[0].toLowerCase();
    if (/\.(png|jpe?g|gif|svg|webp|css|js)$/.test(e) || e.includes('example.') || e.includes('sentry.io')) continue;
    return e;
  }
  return null;
}

const SOCIAL: [string, RegExp][] = [['facebook', /(?:facebook\.com|fb\.com)/], ['instagram', /instagram\.com/], ['linkedin', /linkedin\.com/], ['twitter', /(?:twitter\.com|\/\/(?:www\.)?x\.com)/]];

const NAME_STOP = new Set(['ltd', 'limited', 'the', 'and', 'company', 'services', 'group', 'llp', 'plc']);
// A profile page, not a post, group, photo or search on the network.
const PROFILE = /^https:\/\/(?:[a-z]+\.)?(?:facebook\.com\/(?:profile\.php\?id=\d+|(?!groups\/|events\/|photo|watch|share|people\/|hashtag)[^/?#]+)|instagram\.com\/(?!p\/|reel|explore|stories)[^/?#]+|linkedin\.com\/(?:company|in)\/[^/?#]+|(?:twitter|x)\.com\/(?!search|hashtag|i\/)[^/?#]+)\/?$/i;

// Social profiles found by searching for the business by name, for leads whose website does not link them or that have none.
// A result only counts when its title or summary has the business name in it (one word may be missing from a long name).
export async function findSocial(company: string, town: string) {
  const words = company.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !NAME_STOP.has(w));
  const data = await firecrawlSearch({ query: `"${company}" ${town} (site:facebook.com OR site:instagram.com OR site:linkedin.com OR site:x.com)`,
    limit: 10, location: 'United Kingdom', country: 'GB' });
  const social: Record<string, string> = {};
  for (const r of data.data?.web ?? []) {
    const url = /profile\.php\?id=\d+/.test(r.url) ? r.url.replace(/&.*/, '') : r.url.split(/[?#]/)[0];
    const text = `${r.title ?? ''} ${r.description ?? ''}`.toLowerCase();
    if (!words.length || !PROFILE.test(url) || words.filter(w => !text.includes(w)).length > (words.length > 2 ? 1 : 0)) continue;
    const name = SOCIAL.find(([, re]) => re.test(url))?.[0];
    if (name && !social[name]) social[name] = url;
  }
  return social;
}

function links(html: string, base: string) {
  const out: { href: string; text: string }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try { out.push({ href: new URL(m[1], base).href, text: m[2].replace(/<[^>]+>/g, ' ').trim() }); } catch { /* not a link */ }
  }
  return out;
}

// Everything that can be judged from the HTML alone, so it can be tested without a network.
export function analyse(html: string, url: string, year = new Date().getFullYear()) {
  const issues: Record<string, unknown> = {};
  const seo: Record<string, unknown> = {};
  if (!url.startsWith('https:')) issues.no_ssl = true;
  if (!/<meta[^>]+name=["']viewport["']/i.test(html)) issues.no_mobile_viewport = true;
  const years = [...html.matchAll(/(?:©|&copy;|copyright)\D{0,10}((?:19|20)\d{2})/gi)].map(m => Number(m[1]));
  if (years.length && year - Math.max(...years) >= 2) issues.old_copyright_year = Math.max(...years);

  if (!/<title[^>]*>\s*[^<\s]/i.test(html)) seo.no_title = true;
  if (!/<meta[^>]+name=["']description["'][^>]*content=["']\s*[^"'\s]/i.test(html)) seo.no_meta_description = true;
  const h1 = (html.match(/<h1\b/gi) ?? []).length;
  if (h1 === 0) seo.no_h1 = true; else if (h1 > 1) seo.multiple_h1 = h1;
  const noAlt = (html.match(/<img\b(?![^>]*\balt=)[^>]*>/gi) ?? []).length;
  if (noAlt) seo.images_missing_alt = noAlt;
  if (!/<link[^>]+rel=["']canonical["']/i.test(html)) seo.no_canonical = true;
  if (!/application\/ld\+json|itemtype=["'][^"']*schema\.org/i.test(html)) seo.no_structured_data = true;
  if (!/<meta[^>]+property=["']og:/i.test(html)) seo.no_open_graph = true;

  const social: Record<string, string> = {};
  for (const { href } of links(html, url)) {
    if (/sharer|share\.php|\/share\b|\/plugins\/|\/intent\/|\/dialog\//i.test(href)) continue;
    for (const [name, re] of SOCIAL) {
      if (!social[name] && re.test(href)) { try { if (new URL(href).pathname.length > 1) social[name] = href; } catch { /* skip */ } }
    }
  }
  return { issues, seo, email: findEmail(html), social };
}

export async function checkSite(raw: string): Promise<SiteCheck> {
  const bare = raw.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  const secure = await load(`https://${bare}`);
  const page = secure.ok ? secure : await load(`http://${bare}`);
  if (page.error) return { reachable: false, url: raw, issues: {}, seo: {}, email: null, social: {}, note: why(secure.error || page.error) };
  // A site behind bot protection is up, but its content cannot be judged from here.
  if (isChallenge(page.html) || page.status === 403) return { reachable: true, url: page.url, issues: {}, seo: {}, email: null, social: {}, note: 'Site blocks automatic checks' };
  if (!page.ok) return { reachable: false, url: page.url, issues: {}, seo: {}, email: null, social: {}, note: `It answered with error ${page.status}` };

  const found = analyse(page.html, page.url);
  if (!found.email) {
    // The contact page linked from the home page, or the usual addresses if none is linked.
    const host = new URL(page.url).host;
    const linked = links(page.html, page.url).filter(l => new URL(l.href).host === host && /contact|get-in-touch|about/i.test(l.href + ' ' + l.text)).map(l => l.href);
    // Each page Firecrawl reads costs a credit, so a site only it can reach gets one contact page, not three.
    const tries = [...new Set(linked.length ? linked : ['/contact', '/contact-us'].map(p => new URL(p, page.url).href))].slice(0, page.firecrawl ? 1 : 3);
    for (const href of tries) {
      const c = await load(href);
      if (c?.ok && (found.email = findEmail(c.html))) break;
    }
  }
  return { reachable: true, url: page.url, ...found };
}
