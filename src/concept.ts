// A homepage concept for a lead: their logo, colours, photos and wording taken from their own website, the words
// rewritten by Claude, laid out cleanly and shot as a desktop and a phone view side by side. The picture goes inside
// their outreach email, so they see their own business looking better without clicking anything.
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.ts';
import { DATA_DIR, fail } from './config.ts';
import { lead } from './leads.ts';
import { readSite, snap } from './render.ts';
import { runPrompt } from './copy.ts';
import { pageText } from './page.ts';

type Copy = { headline: string; highlight: string; intro: string; cta: string; trust: string[]; services: { title: string; text: string }[];
  about_title: string; about: string; closing: string; nav: string[] };
type Brand = { colours: string[]; logo: string | null; logo_on_dark: boolean; photos: string[]; phone: string };
export type Concept = { brand: Brand; copy: Copy; made_at: string; cost_gbp: number };

const dir = (id: number) => path.join(DATA_DIR, 'concepts', String(id));
export const FILES = ['showcase.jpg', 'desktop.jpg', 'phone.jpg'] as const;
export const conceptFile = (id: number, name: string) => FILES.includes(name as any) ? path.join(dir(id), name) : fail(404, 'No such file');
export const hasConcept = (id: number) => fs.existsSync(path.join(dir(id), 'showcase.jpg'));
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

// Runs inside their page: the logo, the colours used most on buttons, headings and bands, the biggest photos and a phone number.
export function extract() {
  const abs = (u: string) => { try { return new URL(u, location.href).href; } catch { return ''; } };
  const rgb = (c: string) => { const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/); return m && (m[4] === undefined || +m[4] > .5) ? [+m[1], +m[2], +m[3]] : null; };
  const tally = new Map<string, number>();
  const add = (c: string, w: number) => {
    const v = rgb(c);
    if (!v || Math.max(...v) - Math.min(...v) < 45 || /^(0,0,238|85,26,139)$/.test(v.join(','))) return; // greys, black, white and the browser's own link colours are not a brand
    const k = '#' + v.map(x => Math.round(x).toString(16).padStart(2, '0')).join('');
    tally.set(k, (tally.get(k) ?? 0) + w);
  };
  const theme = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content;
  if (theme) { const t = document.createElement('i'); t.style.color = theme; document.body.append(t); add(getComputedStyle(t).color, 3000); t.remove(); }
  for (const el of [...document.querySelectorAll<HTMLElement>('header, nav, footer, section, a, button, h1, h2, h3, [class*="btn"], [class*="button"]')].slice(0, 3000)) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const s = getComputedStyle(el);
    add(s.backgroundColor, 50 + Math.min(r.width * r.height, 200_000) / 100);
    if (/^(A|BUTTON|H1|H2|H3)$/.test(el.tagName)) add(s.color, 40);
  }
  const named = (el: Element) => /logo/i.test([el.id, (el as any).className?.baseVal ?? (el as HTMLElement).className, el.getAttribute('alt'), el.getAttribute('src'),
    el.parentElement?.className, el.closest('a')?.className].join(' '));
  const near = (el: Element) => { const r = el.getBoundingClientRect(); return r.top + scrollY < 320 && r.width >= 40 && r.height >= 14; };
  const imgs = [...document.images];
  const logo = imgs.find(i => named(i) && near(i)) ?? [...document.querySelectorAll('svg')].find(s => named(s) && near(s))
    ?? document.querySelector('header img, nav img, a[href="/"] img');
  let bg: Element | null = logo, dark = false;
  while (bg) { const c = rgb(getComputedStyle(bg).backgroundColor); if (c) { dark = (c[0] * 299 + c[1] * 587 + c[2] * 114) / 1000 < 110; break; } bg = bg.parentElement; }
  const photos: [string, number][] = [];
  for (const i of imgs) {
    const r = i.getBoundingClientRect();
    if (i !== logo && i.naturalWidth >= 500 && i.naturalHeight >= 280 && r.width >= 150) photos.push([abs(i.currentSrc || i.src), r.width * r.height + i.naturalWidth]);
  }
  for (const el of [...document.querySelectorAll('body *')].slice(0, 3000)) {
    const m = getComputedStyle(el).backgroundImage.match(/url\("?(.*?)"?\)/);
    const r = el.getBoundingClientRect();
    if (m && r.width >= 500 && r.height >= 250) photos.push([abs(m[1]), r.width * r.height]);
  }
  const tel = document.querySelector<HTMLAnchorElement>('a[href^="tel:"]');
  return {
    colours: [...tally].sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 3),
    logo: !logo ? null : logo instanceof HTMLImageElement ? { src: abs(logo.currentSrc || logo.src) } : { svg: new XMLSerializer().serializeToString(logo) },
    logo_on_dark: dark,
    photos: [...new Set(photos.sort((a, b) => b[1] - a[1]).map(([u]) => u))].slice(0, 8),
    phone: (tel?.textContent?.trim() || decodeURIComponent(tel?.getAttribute('href')?.slice(4) ?? '')).slice(0, 30),
  };
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/gif': 'gif', 'image/avif': 'avif' };

// Their brand, saved beside the concept, plus their wording for Claude. A lead with no website gets an empty brand.
async function brandOf(id: number, site: string): Promise<{ brand: Brand; title: string; text: string }> {
  const empty = { brand: { colours: [], logo: null, logo_on_dark: false, photos: [], phone: '' }, title: '', text: '' };
  if (!site) return empty;
  const { data, html, images } = await readSite(site, extract);
  const brand: Brand = { colours: data.colours, logo: null, logo_on_dark: data.logo_on_dark, photos: [], phone: data.phone };
  const save = (name: string, img: { type: string; body: Buffer } | undefined) => {
    if (!img) return null;
    const file = `${name}.${EXT[img.type]}`;
    fs.writeFileSync(path.join(dir(id), file), img.body);
    return file;
  };
  if (data.logo && 'svg' in data.logo) brand.logo = save('logo', { type: 'image/svg+xml', body: Buffer.from((data.logo as { svg: string }).svg) });
  else if (data.logo) brand.logo = save('logo', images.get((data.logo as { src: string }).src));
  for (const u of data.photos) {
    const img = images.get(u);
    if (img && img.type !== 'image/svg+xml' && img.type !== 'image/gif' && img.body.length > 15_000 && brand.photos.length < 3) brand.photos.push(save(`photo-${brand.photos.length + 1}`, img)!);
  }
  const t = pageText(html);
  return { brand, title: t.title, text: [t.description, t.text].filter(Boolean).join('\n').slice(0, 6000) };
}

// Colour sums for a palette that always reads: a light brand colour becomes the accent on a dark base.
const hex = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const toHex = (c: number[]) => '#' + c.map(x => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('');
const mix = (a: string, b: string, t: number) => toHex(hex(a).map((x, i) => x + (hex(b)[i] - x) * t));
const lum = (h: string) => { const [r, g, b] = hex(h).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };

function palette(colours: string[]) {
  const brand = colours[0] ?? '#24527a';
  const dark = mix(brand, '#0b0f14', lum(brand) > .3 ? .82 : .62);
  return { brand, ink: lum(brand) > .4 ? '#141414' : '#ffffff', dark, hl: lum(brand) > .18 ? brand : mix(brand, '#ffffff', .55), soft: mix(brand, '#ffffff', .9) };
}

const dataUri = (id: number, file: string) => {
  const type = Object.entries(EXT).find(([, e]) => file.endsWith(`.${e}`))![0];
  return `data:${type};base64,${fs.readFileSync(path.join(dir(id), file)).toString('base64')}`;
};

// The homepage itself. One layout that works at desktop and phone widths.
export function pageHtml(id: number, l: { company_name: string; industry: string; town: string; rating?: number | null; reviews?: number | null }, c: Concept) {
  const p = palette(c.brand.colours), b = c.brand, k = c.copy;
  const photo = (i: number) => b.photos[i] ? dataUri(id, b.photos[i]) : '';
  const word = k.highlight.trim(), at = word ? k.headline.toLowerCase().indexOf(word.toLowerCase()) : -1;
  const headline = at < 0 ? esc(k.headline) : `${esc(k.headline.slice(0, at))}<em>${esc(k.headline.slice(at, at + word.length))}</em>${esc(k.headline.slice(at + word.length))}`;
  const logo = b.logo ? `<img src="${dataUri(id, b.logo)}" alt="">` : `<span class="word">${esc(l.company_name)}</span>`;
  const stars = l.rating ? `<div class="stars"><span>★★★★★</span> ${esc(l.rating)} from ${esc(l.reviews ?? 0)} Google reviews</div>` : '';
  const tick = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><style>
  @font-face { font-family: Archivo; font-weight: 400; src: url(/fonts/archivo-latin-400-normal.woff2) format('woff2'); }
  @font-face { font-family: Archivo; font-weight: 500 700; src: url(/fonts/archivo-latin-500-normal.woff2) format('woff2'); }
  @font-face { font-family: Archivo; font-weight: 800 900; src: url(/fonts/archivo-latin-900-normal.woff2) format('woff2'); }
  :root { --brand: ${p.brand}; --ink: ${p.ink}; --dark: ${p.dark}; --hl: ${p.hl}; --soft: ${p.soft}; }
  * { box-sizing: border-box; } body { margin: 0; font: 17px/1.6 Archivo, sans-serif; color: #2a2a2a; background: #fff; }
  h1, h2, h3 { margin: 0; color: #141414; line-height: 1.12; } p { margin: 0; }
  .wrap { max-width: 1200px; margin: 0 auto; padding: 0 40px; }
  .btn { display: inline-block; padding: 15px 26px; border-radius: 10px; background: var(--brand); color: var(--ink); font-weight: 700; text-decoration: none; white-space: nowrap; }
  .btn.ghost { background: transparent; color: #fff; box-shadow: inset 0 0 0 2px rgba(255,255,255,.7); }
  .nav { background: ${b.logo_on_dark ? 'var(--dark)' : '#fff'}; border-bottom: 1px solid rgba(0,0,0,.06); }
  .nav .wrap { display: flex; align-items: center; gap: 36px; height: 92px; }
  .nav img { max-height: 56px; max-width: 220px; display: block; }
  .word { font-weight: 900; font-size: 24px; color: ${b.logo_on_dark ? '#fff' : 'var(--dark)'}; }
  .nav nav { display: flex; gap: 30px; margin-left: auto; font-weight: 500; color: ${b.logo_on_dark ? 'rgba(255,255,255,.85)' : '#333'}; }
  .burger { display: none; margin-left: auto; width: 28px; height: 3px; background: ${b.logo_on_dark ? '#fff' : '#222'}; box-shadow: 0 -9px 0 ${b.logo_on_dark ? '#fff' : '#222'}, 0 9px 0 ${b.logo_on_dark ? '#fff' : '#222'}; border-radius: 2px; }
  .hero { position: relative; color: #fff; background: ${photo(0) ? `linear-gradient(100deg, color-mix(in srgb, var(--dark) 92%, transparent) 30%, color-mix(in srgb, var(--dark) 45%, transparent)), url(${photo(0)}) center / cover`
    : 'radial-gradient(circle at 85% 20%, color-mix(in srgb, var(--brand) 55%, transparent), transparent 55%), var(--dark)'}; }
  .hero .wrap { padding-top: 110px; padding-bottom: 120px; display: grid; grid-template-columns: 1fr 380px; gap: 60px; align-items: center; }
  .quote { background: #fff; color: #222; border-radius: 18px; padding: 30px; box-shadow: 0 30px 60px rgba(0,0,0,.25); display: grid; gap: 14px; }
  .quote h3 { font-size: 22px; } .quote span { display: block; border: 1px solid #e3e3e3; border-radius: 10px; padding: 13px 14px; color: #999; font-size: 15px; background: #fafafa; }
  .quote .btn { text-align: center; } .quote small { color: #777; font-size: 13px; text-align: center; }
  .eyebrow { text-transform: uppercase; letter-spacing: .14em; font-size: 13px; font-weight: 700; color: rgba(255,255,255,.75); margin-bottom: 18px; }
  .hero h1 { color: #fff; font-weight: 900; font-size: 64px; max-width: 760px; letter-spacing: -.01em; }
  .hero h1 em { font-style: normal; color: var(--hl); }
  .hero .lead { font-size: 21px; max-width: 600px; margin: 22px 0 34px; color: rgba(255,255,255,.88); }
  .actions { display: flex; gap: 14px; flex-wrap: wrap; }
  .stars { margin-top: 30px; font-size: 15px; color: rgba(255,255,255,.85); } .stars span { color: #f5b301; letter-spacing: 2px; margin-right: 6px; }
  .trust { background: var(--soft); } .trust .wrap { display: flex; justify-content: space-between; gap: 24px; padding-top: 26px; padding-bottom: 26px; }
  .trust div { display: flex; align-items: center; gap: 12px; font-weight: 700; color: #1d1d1d; }
  svg { width: 26px; height: 26px; flex: none; fill: none; stroke: var(--dark); stroke-width: 2.6; stroke-linecap: round; stroke-linejoin: round; background: #fff; border-radius: 50%; padding: 4px; }
  section.block { padding: 100px 0; }
  .kicker { color: var(--dark); font-weight: 700; text-transform: uppercase; letter-spacing: .12em; font-size: 13px; margin-bottom: 12px; }
  h2 { font-size: 42px; font-weight: 900; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; margin-top: 44px; }
  .card { border: 1px solid #ececec; border-radius: 16px; padding: 30px; box-shadow: 0 10px 30px rgba(0,0,0,.04); }
  .card b { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 12px; background: var(--soft); color: var(--dark); font-size: 18px; margin-bottom: 20px; }
  .card h3 { font-size: 21px; margin-bottom: 10px; } .card p { color: #555; font-size: 16px; }
  .about { background: #f7f6f5; } .split { display: grid; grid-template-columns: ${photo(1) ? '1fr 1fr' : '1fr'}; gap: 64px; align-items: center; }
  .split img { width: 100%; height: 440px; object-fit: cover; border-radius: 18px; display: block; }
  .about p { margin-top: 20px; font-size: 18px; color: #444; max-width: 640px; }
  .band { background: var(--brand); color: var(--ink); } .band .wrap { display: flex; align-items: center; justify-content: space-between; gap: 30px; padding-top: 64px; padding-bottom: 64px; }
  .band h2 { color: var(--ink); font-size: 36px; } .band .btn { background: var(--dark); color: #fff; }
  footer { background: #141414; color: rgba(255,255,255,.7); font-size: 15px; } footer .wrap { display: flex; justify-content: space-between; padding-top: 36px; padding-bottom: 36px; gap: 20px; }
  footer b { color: #fff; }
  @media (max-width: 700px) {
    .wrap { padding: 0 22px; } .nav .wrap { height: 72px; } .nav nav, .nav .btn { display: none; } .burger { display: block; } .nav img { max-height: 44px; max-width: 170px; }
    .hero .wrap { padding-top: 64px; padding-bottom: 72px; display: block; } .quote { display: none; } .hero h1 { font-size: 38px; } .hero .lead { font-size: 18px; }
    .trust .wrap { flex-direction: column; gap: 14px; } section.block { padding: 64px 0; } h2 { font-size: 32px; }
    .grid { grid-template-columns: 1fr; gap: 16px; margin-top: 28px; } .card { padding: 24px; } .split { grid-template-columns: 1fr; gap: 28px; } .split img { height: 260px; }
    .band .wrap { flex-direction: column; align-items: flex-start; } .band h2 { font-size: 28px; } footer .wrap { flex-direction: column; }
  }
</style></head><body>
  <header class="nav"><div class="wrap">${logo}<nav>${k.nav.slice(0, 5).map(n => `<span>${esc(n)}</span>`).join('')}</nav>
    <a class="btn">${esc(b.phone ? `Call ${b.phone}` : k.cta)}</a><span class="burger"></span></div></header>
  <section class="hero"><div class="wrap"><div>
    <p class="eyebrow">${esc(l.industry)}${l.town ? ` in ${esc(l.town)}` : ''}</p>
    <h1>${headline}</h1><p class="lead">${esc(k.intro)}</p>
    <div class="actions"><a class="btn">${esc(k.cta)}</a>${b.phone ? `<a class="btn ghost">Call ${esc(b.phone)}</a>` : ''}</div>${stars}</div>
    <div class="quote"><h3>${esc(k.cta)}</h3><span>Your name</span><span>Phone number</span><span>What do you need help with?</span><a class="btn">Send</a></div>
  </div></section>
  <div class="trust"><div class="wrap">${k.trust.slice(0, 3).map(t => `<div>${tick}${esc(t)}</div>`).join('')}</div></div>
  <section class="block"><div class="wrap"><p class="kicker">${esc(k.nav[0] ?? 'Services')}</p><h2>How we can help</h2>
    <div class="grid">${k.services.slice(0, 6).map((s, i) => `<div class="card"><b>${i + 1}</b><h3>${esc(s.title)}</h3><p>${esc(s.text)}</p></div>`).join('')}</div></div></section>
  <section class="block about"><div class="wrap split">${photo(1) ? `<img src="${photo(1)}" alt="">` : ''}<div><p class="kicker">About us</p><h2>${esc(k.about_title)}</h2><p>${esc(k.about)}</p></div></div></section>
  <section class="band"><div class="wrap"><h2>${esc(k.closing)}</h2><a class="btn">${esc(k.cta)}</a></div></section>
  <footer><div class="wrap"><span><b>${esc(l.company_name)}</b>${l.town ? `, ${esc(l.town)}` : ''}</span><span>${esc(b.phone)}</span></div></footer>
</body></html>`;
}

// Desktop and phone side by side, as they would see it in the email.
function showcaseHtml(desktop: string, phone: string, company: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face { font-family: Archivo; font-weight: 500 700; src: url(/fonts/archivo-latin-500-normal.woff2) format('woff2'); }
  * { box-sizing: border-box; } body { margin: 0; width: 1600px; height: 1000px; background: linear-gradient(160deg, #f4f1ef, #e7e2df); font-family: Archivo, sans-serif; position: relative; overflow: hidden; }
  .desk { position: absolute; left: 60px; top: 70px; width: 1180px; border-radius: 14px; overflow: hidden; background: #fff; box-shadow: 0 30px 80px rgba(0,0,0,.18); }
  .chrome { height: 40px; background: #ecebea; display: flex; align-items: center; gap: 8px; padding: 0 16px; }
  .chrome i { width: 12px; height: 12px; border-radius: 50%; background: #d3cfcd; }
  .desk div.shot { height: 820px; background: url(${desktop}) top / 100% auto no-repeat; }
  .phone { position: absolute; right: 70px; top: 130px; width: 340px; height: 720px; border-radius: 46px; background: #121212; padding: 14px; box-shadow: 0 30px 80px rgba(0,0,0,.28); }
  .phone div { width: 100%; height: 100%; border-radius: 34px; background: url(${phone}) top / 100% auto no-repeat; }
  .label { position: absolute; left: 60px; bottom: 24px; font-size: 18px; font-weight: 600; color: #6d6461; }
</style></head><body>
  <div class="desk"><div class="chrome"><i></i><i></i><i></i></div><div class="shot"></div></div>
  <div class="phone"><div></div></div>
  <p class="label">A homepage concept for ${esc(company)}, by Red Cherry IT</p>
</body></html>`;
}

const get = (id: number) => { const l = lead(id) as any; return { l, c: l.concept as Concept | null }; };

async function shoot(id: number, l: any, c: Concept) {
  const html = pageHtml(id, l, c);
  const desktop = await snap(html, 1440, 900, { full: true });
  const phone = await snap(html, 390, 844, { full: true, scale: 2 });
  fs.writeFileSync(path.join(dir(id), 'desktop.jpg'), desktop);
  fs.writeFileSync(path.join(dir(id), 'phone.jpg'), phone);
  const uri = (b: Buffer) => `data:image/jpeg;base64,${b.toString('base64')}`;
  fs.writeFileSync(path.join(dir(id), 'showcase.jpg'), await snap(showcaseHtml(uri(desktop), uri(phone), l.company_name), 1600, 1000));
}

// Reads their site, has Claude write the words and takes the pictures. Asking again makes a fresh one.
export async function make(id: number) {
  const { l } = get(id);
  fs.rmSync(dir(id), { recursive: true, force: true });
  fs.mkdirSync(dir(id), { recursive: true });
  const site = l.website_url && !String(l.lead_reason).startsWith('Website listed but unreachable') ? l.website_url : '';
  const { brand, title, text } = await brandOf(id, site).catch(() => brandOf(id, '')); // a site that will not load still gets a concept
  if (!brand.phone && l.phone) brand.phone = l.phone;
  const r = await runPrompt('lead-concept', {
    company: l.company_name, industry: l.industry, town: l.town, title: title || 'none',
    reviews: l.rating ? `${l.rating} stars from ${l.reviews ?? 0} reviews` : 'not known', text: text || 'none (no website)',
  }, { job: 'lead:concept' });
  const c: Concept = { brand, copy: r.output, made_at: new Date().toISOString(), cost_gbp: +r.cost_gbp.toFixed(4) };
  await shoot(id, l, c);
  db.prepare(`UPDATE leads SET concept = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(c), id);
  db.prepare(`INSERT INTO lead_activity (lead_id, kind, text) VALUES (?, 'note', 'Made a homepage concept')`).run(id);
  return c;
}

// David's changes to the words. The pictures are taken again; no Claude.
export async function edit(id: number, copy: Partial<Copy>) {
  const { l, c } = get(id);
  if (!c) fail(404, 'Make a concept for this lead first');
  c!.copy = { ...c!.copy, ...copy };
  await shoot(id, l, c!);
  db.prepare(`UPDATE leads SET concept = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(c), id);
  return c!;
}
