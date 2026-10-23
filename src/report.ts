// A one lead website report David can send to a prospect: Red Cherry IT branded, plain English, made from the
// last analysis with no Claude call. Rendered to an A4 PDF by the same Chromium as the social posts.
import fs from 'node:fs';
import { fail } from './config.ts';
import { lead, screenshotPath } from './leads.ts';
import { pdf } from './render.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

// Every check, passed or not, so the report shows what is right as well as what needs fixing.
// key: [where it is kept, heading, why it matters]
const CHECKS: [string, 'website_issues' | 'seo_issues', string, string][] = [
  ['no_ssl', 'website_issues', 'Secure connection (https)', 'Browsers warn visitors that a site without it is not secure, and Google ranks it lower.'],
  ['no_mobile_viewport', 'website_issues', 'Works on phones', 'Most visitors arrive on a phone. Without this the page shows tiny and has to be pinched and zoomed.'],
  ['old_copyright_year', 'website_issues', 'Looks up to date', 'An old year at the bottom of the page makes visitors wonder if the business is still trading.'],
  ['no_title', 'seo_issues', 'Page title', 'This is the headline Google shows in its results. Without it Google guesses, often badly.'],
  ['no_meta_description', 'seo_issues', 'Search result description', 'The short summary under the headline in Google. A good one gets more people to click.'],
  ['no_h1', 'seo_issues', 'Main heading', 'Tells Google and visitors what the page is about at a glance.'],
  ['multiple_h1', 'seo_issues', 'One clear main heading', 'Several competing main headings blur what the page is about.'],
  ['images_missing_alt', 'seo_issues', 'Image descriptions', 'Google cannot see pictures. A short description helps them show in image searches and helps visitors who use screen readers.'],
  ['no_canonical', 'seo_issues', 'Preferred page address', 'Stops Google splitting the page\'s ranking between different versions of the same address.'],
  ['no_structured_data', 'seo_issues', 'Business details for Google', 'Lets Google show your opening hours, reviews and contact details straight in the results.'],
  ['no_open_graph', 'seo_issues', 'Social sharing preview', 'Controls the picture and text shown when someone shares the site on Facebook, LinkedIn or WhatsApp.'],
];

const SCORES: [string, string][] = [['performance', 'Speed on phones'], ['seo', 'Search engine basics'], ['accessibility', 'Accessibility'], ['best-practices', 'Best practices']];

function gauge(score: number | undefined, label: string) {
  const colour = score === undefined ? '#bbb' : score >= 90 ? '#16794f' : score >= 50 ? '#c07a00' : '#b5333f';
  return `<div class="gauge"><div class="ring" style="background:conic-gradient(${colour} ${score ?? 0}%, #ebe7e7 0)"><span style="color:${colour}">${score ?? 'n/a'}</span></div><p>${esc(label)}</p></div>`;
}

function detail(key: string, value: unknown) {
  if (key === 'old_copyright_year') return ` The footer still says ${esc(value)}.`;
  if (key === 'multiple_h1') return ` We found ${esc(value)}.`;
  if (key === 'images_missing_alt') return ` ${esc(value)} ${value === 1 ? 'image has' : 'images have'} none.`;
  return '';
}

export function reportHtml(id: number) {
  const l = lead(id) as any;
  if (!l.website_url) fail(400, 'This lead has no website to report on');
  if (!l.analysed_at) fail(400, 'Analyse this lead first, so the report has something to show');
  const a = l.analysis, ps = a.pagespeed, g = a.gbp;
  const scores = ps?.scores ?? (ps ? { performance: ps.score } : {});
  const checks = CHECKS.filter(([key]) => key !== 'multiple_h1' || l.seo_issues.multiple_h1)
    .filter(([key]) => !(key === 'no_h1' && l.seo_issues.multiple_h1));
  const failed = checks.filter(([key, where]) => l[where][key] !== undefined);
  const shot = fs.existsSync(screenshotPath(id)) ? `data:image/jpeg;base64,${fs.readFileSync(screenshotPath(id)).toString('base64')}` : '';
  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const presence = [
    g ? `<li><b>Google Business Profile:</b> ${g.rating ? `${esc(g.rating)} stars from ${esc(g.reviews ?? 0)} reviews` : 'no reviews yet'}${g.has_hours === false ? ', no opening hours listed' : ''}${g.photos === 0 ? ', no photos' : ''}.</li>`
      : '<li><b>Google Business Profile:</b> we could not find one. It is free, and it is how most people find a local business on Google Maps.</li>',
    `<li><b>Social media:</b> ${Object.keys(l.social_links).length ? `linked to ${esc(Object.keys(l.social_links).join(', '))}` : 'no profiles linked from the website'}.</li>`,
    a.domain ? `<li><b>Web address:</b> registered ${esc(a.domain.years)} ${a.domain.years === 1 ? 'year' : 'years'} ago.</li>` : '',
    ps?.lcp ? `<li><b>Loading time on a phone:</b> the main content takes ${esc(ps.lcp)} to appear. Google suggests under 2.5 seconds.</li>` : '',
  ].join('');

  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><style>
  @font-face { font-family: "Archivo"; font-weight: 400; src: url(/fonts/archivo-latin-400-normal.woff2) format("woff2"); }
  @font-face { font-family: "Archivo"; font-weight: 500; src: url(/fonts/archivo-latin-500-normal.woff2) format("woff2"); }
  @font-face { font-family: "Archivo"; font-weight: 900; src: url(/fonts/archivo-latin-900-normal.woff2) format("woff2"); }
  @page { size: A4; margin: 16mm 16mm 18mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 400 10.5pt/1.45 Archivo, sans-serif; color: #444; }
  h1, h2, b { color: #1a1a1a; }
  h1 { font-weight: 900; font-size: 26pt; line-height: 1.1; margin: 6mm 0 1mm; }
  h1 em { font-style: normal; color: #b5333f; }
  h2 { font-weight: 900; font-size: 14pt; margin: 8mm 0 3mm; break-after: avoid; }
  .top { display: flex; justify-content: space-between; align-items: center; }
  .top img { height: 11mm; }
  .tag { font: 500 8pt Archivo; letter-spacing: .12em; text-transform: uppercase; color: #a89c9c; }
  .bar { width: 18mm; height: 1.4mm; background: #b5333f; margin-top: 6mm; }
  .site { color: #a89c9c; margin: 0; }
  .shot { width: 100%; border: 1px solid #e4dfdf; border-radius: 2mm; margin-top: 2mm; }
  .gauges { display: flex; justify-content: space-between; gap: 4mm; }
  .gauge { flex: 1; text-align: center; }
  .ring { width: 24mm; height: 24mm; border-radius: 50%; margin: 0 auto; display: grid; place-items: center; position: relative; }
  .ring::before { content: ""; position: absolute; inset: 3.2mm; background: #fff; border-radius: 50%; }
  .ring span { position: relative; font-weight: 900; font-size: 15pt; }
  .gauge p { margin: 2mm 0 0; font-size: 9pt; }
  .note { font-size: 8.5pt; color: #888; }
  .check { display: grid; grid-template-columns: 7mm 1fr; padding: 2.4mm 0; border-bottom: 1px solid #eee; break-inside: avoid; }
  .mark { font-weight: 900; }
  .ok .mark { color: #16794f; } .fix .mark { color: #b5333f; }
  .check p { margin: .6mm 0 0; font-size: 9.5pt; }
  ul { padding-left: 5mm; } li { margin-bottom: 1.5mm; }
  .end { margin-top: 8mm; padding: 5mm 6mm; background: #f6f3f3; border-left: 1.4mm solid #b5333f; break-inside: avoid; }
  .end p { margin: 0 0 2mm; } .end p:last-child { margin: 0; }
  footer { margin-top: 8mm; padding-top: 3mm; border-top: 1px solid #1a1a1a; display: flex; justify-content: space-between; font-size: 9pt; }
  footer span:last-child { color: #b5333f; font-weight: 500; }
</style></head><body>
  <div class="top"><img src="/assets/logo.png" alt="Red Cherry IT"><span class="tag">Website report · ${esc(date)}</span></div>
  <div class="bar"></div>
  <h1>How <em>${esc(l.company_name)}</em> looks online</h1>
  <p class="site">${esc(l.website_url)}</p>
  ${shot ? `<h2>Your website today</h2><img class="shot" src="${shot}" alt="">` : ''}
  <h2>Google's scores</h2>
  ${Object.keys(scores).length ? `<div class="gauges">${SCORES.filter(([k]) => k in scores || k === 'performance').map(([k, label]) => gauge(scores[k], label)).join('')}</div>
  <p class="note">Out of 100, from Google's own PageSpeed test on a mobile phone. 90 and above is good, under 50 is poor.</p>`
    : '<p>Google\'s speed test could not finish on this website when we checked, often because the site is slow to respond or blocks automated visits.</p>'}
  <h2>What we checked</h2>
  <p>${failed.length ? `${failed.length} of ${checks.length} checks need attention.` : `All ${checks.length} checks passed.`}</p>
  ${checks.map(([key, where, title, why]) => {
    const bad = l[where][key] !== undefined;
    return `<div class="check ${bad ? 'fix' : 'ok'}"><span class="mark">${bad ? '✕' : '✓'}</span><div><b>${esc(title)}</b>${bad ? `<p>${esc(why)}${detail(key, l[where][key])}</p>` : ''}</div></div>`;
  }).join('')}
  <h2>Beyond the website</h2>
  <ul>${presence}</ul>
  <div class="end">
    <p><b>What next?</b></p>
    <p>Every point marked ✕ can be fixed, and most quickly. If you would like, we will put together a free concept showing how a faster, clearer website could win ${esc(l.company_name)} more enquiries. Just reply to our email.</p>
  </div>
  <footer><span><b>Red Cherry IT</b>, web design and digital marketing</span><span>redcherryit.com</span></footer>
</body></html>`;
}

export const reportPdf = (id: number) => pdf(reportHtml(id));
