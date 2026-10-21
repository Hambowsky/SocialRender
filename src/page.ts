// Reads a web page as plain text so Claude can write a post about it.
import dns from 'node:dns/promises';
import net from 'node:net';
import { fail } from './config.ts';

// Only public addresses, so a link can never be used to read things on this server or its network.
const blocked = new net.BlockList();
for (const [a, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const)
  blocked.addSubnet(a, bits, 'ipv4');
for (const [a, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['::ffff:0:0', 96]] as const) blocked.addSubnet(a, bits, 'ipv6');

// ponytail: checks the address before fetching, so a DNS answer that changes in between could slip past. Pin the IP with a custom agent if that ever matters.
async function checkUrl(raw: string) {
  let u: URL;
  try { u = new URL(raw); } catch { return fail(400, 'That link is not a valid web address'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') fail(400, 'The link must start with http or https');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true }).catch(() => fail(400, `Could not find ${host}`));
  if (addrs.some(a => blocked.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4'))) fail(400, 'That link points to a private address');
  return u;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', pound: '£', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', ndash: '–', mdash: '—' };
const decode = (s: string) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) =>
  e[0] === '#' ? String.fromCodePoint(parseInt(e.slice(e[1] === 'x' || e[1] === 'X' ? 2 : 1), e[1] === 'x' || e[1] === 'X' ? 16 : 10) || 32) : ENTITIES[e.toLowerCase()] ?? m);

export function pageText(html: string) {
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
  const description = decode(html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)/i)?.[1] ?? '').trim();
  const body = decode((html.match(/<body[\s\S]*<\/body>/i)?.[0] ?? html)
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|br)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\r\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  return { title, description, text: body };
}

const MAX_CHARS = 15000;

// Follows redirects by hand so every hop is checked against the private address list.
export async function fetchPage(raw: string, accept = 'text/html,text/plain') {
  let url = await checkUrl(raw);
  for (let hops = 0; ; hops++) {
    let res: Response;
    try {
      res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'RedCherryIT-SocialRender/1 (+https://redcherryit.com)', accept } });
    } catch (err) { return fail(502, `Could not load that page: ${(err as Error).message}`); }
    const next = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && next) {
      if (hops >= 4) fail(502, 'That page redirects too many times');
      url = await checkUrl(new URL(next, url).href);
      continue;
    }
    return { url, res };
  }
}

export async function readPage(raw: string) {
  const { url, res } = await fetchPage(raw);
  if (!res.ok) fail(502, `That page returned ${res.status}`);
  if (!/text\/(html|plain)|xhtml/.test(res.headers.get('content-type') ?? '')) fail(400, 'That link is not a web page');
  const html = (await res.text()).slice(0, 2_000_000);
  const page = pageText(html);
  if (page.text.length < 100) fail(422, 'Could not find much text on that page. It may need JavaScript to show its content, so paste the text into Sources instead.');
  return { url: url.href, ...page, text: page.text.slice(0, MAX_CHARS) };
}
