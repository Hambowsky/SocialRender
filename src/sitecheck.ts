// Checks a business's website for the things that make it a lead: missing SSL, not mobile friendly, an old
// copyright year, and basic SEO gaps. Also picks up a contact email and social links. Plain code, no AI.
import { fetchPage } from './page.ts';

export type SiteCheck = {
  reachable: boolean;
  url: string;
  issues: Record<string, unknown>;      // website problems that make it outdated
  seo: Record<string, unknown>;         // SEO gaps, shown on the lead
  email: string | null;
  social: Record<string, string>;
  note?: string;
};

const CHALLENGE = ['checking your browser', 'just a moment', 'one moment, please', 'please wait while we verify', 'verifying you are human',
  'needs to review the security of your connection', 'enable javascript and cookies to continue', 'ddos protection by',
  'attention required! | cloudflare', 'cf-browser-verification', 'cf_chl_opt', 'challenges.cloudflare.com', 'jschl-answer',
  'cdn-cgi/challenge-platform', '_incapsula_resource', 'geo.captcha-delivery.com', 'px-captcha', 'distil_r_captcha'];
const isChallenge = (html: string) => { const head = html.slice(0, 4000).toLowerCase(); return CHALLENGE.some(m => head.includes(m)); };

async function load(url: string) {
  try {
    const { url: final, res } = await fetchPage(url);
    const html = (await res.text()).slice(0, 2_000_000);
    return { ok: res.ok, status: res.status, url: final.href, html };
  } catch { return null; }
}

export function findEmail(html: string) {
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
  let page = await load(`https://${bare}`);
  if (!page?.ok) page = await load(`http://${bare}`);
  if (!page) return { reachable: false, url: raw, issues: {}, seo: {}, email: null, social: {} };
  // A site behind bot protection is up, but its content cannot be judged from here.
  if (isChallenge(page.html) || page.status === 403) return { reachable: true, url: page.url, issues: {}, seo: {}, email: null, social: {}, note: 'Site blocks automatic checks' };
  if (!page.ok) return { reachable: false, url: page.url, issues: {}, seo: {}, email: null, social: {} };

  const found = analyse(page.html, page.url);
  if (!found.email) {
    const contact = links(page.html, page.url).find(l => new URL(l.href).host === new URL(page.url).host && /contact/i.test(l.href + ' ' + l.text));
    const c = contact && await load(contact.href);
    if (c?.ok) found.email = findEmail(c.html);
  }
  return { reachable: true, url: page.url, ...found };
}
