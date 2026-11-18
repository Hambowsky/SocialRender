// Free guides (lead magnets). Claude researches and writes a guide on one topic for one audience, David edits and
// approves it, then publishing makes the PDF (served by the studio) and a landing page on the website whose form
// signs people up to the list. Confirming the sign up emails them the guide. Outreach emails in a campaign can offer it.
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.ts';
import { DATA_DIR, fail, PUBLIC_URL, ROOT, SITE_URL } from './config.ts';
import { current as currentPrompt, fillPromptVars, parsePrompt, systemPrompt } from './copy.ts';
import { ask } from './claude.ts';
import { checks as articleChecks, siteLinks } from './articles.ts';
import { esc, inline, toHtml } from './markdown.ts';
import { pdf } from './render.ts';
import { publishPage } from './site.ts';
import { sendEmail } from './contacts.ts';

export type Magnet = { id: number; slug: string; topic: string; audience: string; title: string; summary: string; body: string; sources: string;
  headline: string; pitch: string; bullets: string; status: string; cost_gbp: number; created_at: string; updated_at: string; published_at: string | null };

export const CATEGORY = '/guides/free/'; // two folders deep like the other guides, so the shared page shell's links work
const DIR = path.join(DATA_DIR, 'guides');
const SHELL = path.join(ROOT, 'site', 'guide.html');
const rules = () => parsePrompt(currentPrompt('lead-magnet').body).settings;
export const pageUrl = (m: Pick<Magnet, 'slug'>) => `${SITE_URL}${CATEGORY}${m.slug}`;
export const pdfUrl = (m: Pick<Magnet, 'slug'>) => `${PUBLIC_URL}/free-guides/${m.slug}.pdf`;
export const pdfFile = (slug: string) => path.join(DIR, `${slug}.pdf`);
const tag = (slug: string) => `guide-${slug}`;

const row = (id: number) => (db.prepare('SELECT * FROM magnets WHERE id = ?').get(id) as Magnet | undefined) ?? fail(404, `There is no guide ${id}`);
// Who asked for it: everyone tagged with it, and how many of them confirmed.
const signups = (slug: string) => db.prepare(`SELECT count(*) AS total, coalesce(sum(status = 'subscribed'), 0) AS confirmed FROM contacts
  WHERE ',' || replace(tags, ' ', '') || ',' LIKE ?`).get(`%,${tag(slug)},%`) as { total: number; confirmed: number };
export const checks = (m: Pick<Magnet, 'body' | 'sources'>) => articleChecks({ ...m, category: CATEGORY }, rules());
export const get = (id: number) => { const m = row(id); return { ...m, url: pageUrl(m), pdf_url: pdfUrl(m), checks: checks(m), signups: signups(m.slug) }; };
export const list = () => (db.prepare('SELECT id, slug, title, status, published_at FROM magnets ORDER BY id DESC').all() as Magnet[])
  .map(m => ({ ...m, url: pageUrl(m), signups: signups(m.slug) }));
// A published guide by its page name, for the sign up form and the PDF link.
export const live = (slug: string) => db.prepare(`SELECT * FROM magnets WHERE slug = ? AND status = 'published'`).get(slug) as Magnet | undefined;

const slugify = (s: string) => s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'free-guide';
function freeSlug(base: string) {
  let slug = base;
  for (let n = 2; db.prepare('SELECT 1 FROM magnets WHERE slug = ?').get(slug); n++) slug = `${base}-${n}`;
  return slug;
}

const str = { type: 'string' };
const SCHEMA = { type: 'object', additionalProperties: false, required: ['title', 'summary', 'body', 'headline', 'pitch', 'bullets', 'sources'], properties: {
  title: str, summary: str, body: str, headline: str, pitch: str, bullets: { type: 'array', items: str },
  sources: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'url', 'facts'], properties: { title: str, url: str, facts: str } } } } };

// Claude searches the web and writes the guide and its landing page in one go. Sources without a web link are dropped.
export async function draft(input: { topic: string; audience?: string }) {
  const topic = input.topic.trim(), audience = input.audience?.trim() || 'UK business owners';
  if (!topic) fail(400, 'Say what the guide is about');
  const p = parsePrompt(currentPrompt('lead-magnet').body);
  const studies = db.prepare('SELECT client, industry, blurb FROM case_studies ORDER BY client').all() as { client: string; industry: string; blurb: string }[];
  const r = await ask({ job: 'guide:draft', model: p.model, effort: p.effort, maxTokens: p.maxTokens, system: systemPrompt(), schema: SCHEMA,
    webSearches: Math.min(Number(p.settings.web_searches || 8), 10),
    messages: [{ role: 'user', content: fillPromptVars(p.text, { topic, audience, site_links: await siteLinks(),
      case_studies: studies.map(c => `${c.client} (${c.industry}): ${c.blurb}`).join('\n') || 'none' }) }] });
  const o = r.output;
  if (!o?.title || !o?.body) fail(502, 'Claude did not return a guide. Try again');
  const sources = (o.sources ?? []).filter((s: any) => /^https?:\/\//.test(s?.url)).map((s: any) => `* ${s.facts} (${s.title}: ${s.url})`).join('\n');
  const { lastInsertRowid } = db.prepare(`INSERT INTO magnets (slug, topic, audience, title, summary, body, sources, headline, pitch, bullets, cost_gbp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(freeSlug(slugify(o.title)), topic, audience, o.title.trim(), o.summary.trim(), o.body.trim(), sources,
    o.headline.trim(), o.pitch.trim(), (o.bullets ?? []).map((b: string) => b.trim()).filter(Boolean).join('\n'), r.cost_gbp);
  return { ...get(Number(lastInsertRowid)), cost_gbp: r.cost_gbp };
}

const FIELDS = ['title', 'summary', 'body', 'sources', 'headline', 'pitch', 'bullets', 'slug'] as const;
export function update(id: number, e: Partial<Record<typeof FIELDS[number], string>>) {
  const m = row(id);
  if (m.status !== 'draft') fail(409, `Only a draft can be edited. This one is ${m.status}.`);
  if (e.slug !== undefined && (slugify(e.slug) !== e.slug || db.prepare('SELECT 1 FROM magnets WHERE slug = ? AND id != ?').get(e.slug, id)))
    fail(400, 'The page name must be lowercase words joined by hyphens, and not used by another guide');
  const v = Object.fromEntries(FIELDS.map(k => [k, e[k] ?? m[k]]));
  db.prepare(`UPDATE magnets SET title = ?, summary = ?, body = ?, sources = ?, headline = ?, pitch = ?, bullets = ?, slug = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(...FIELDS.map(k => v[k]), id);
  return get(id);
}

// approve needs the checks to pass; reopen brings it back for changes (a published one stays live until published again).
const MOVES = { approve: [['draft'], 'approved'], reject: [['draft', 'approved'], 'rejected'], reopen: [['approved', 'rejected', 'published'], 'draft'] } as const;
export function move(id: number, act: keyof typeof MOVES) {
  const m = row(id), [from, to] = MOVES[act];
  if (!(from as readonly string[]).includes(m.status)) fail(409, `This guide is ${m.status}, so it cannot be ${act === 'reopen' ? 'moved back to draft' : `${act}d`}`);
  if (act === 'approve') { const c = checks(m); if (c.errors.length) fail(422, `Fix these first: ${c.errors.join(' ')}`); }
  db.prepare(`UPDATE magnets SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(to, id);
  return get(id);
}

// The PDF: a cover, the guide, and a closing note. Same look as the lead website report.
export function guideHtml(m: Magnet) {
  const date = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const body = toHtml(m.body.replace(/^#\s+.*\n+/, '')).replace(/<li>\[[ xX]?\]\s*/g, '<li class="tick">');
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>${esc(m.title)}</title><style>
  @font-face { font-family: "Archivo"; font-weight: 400; src: url(/fonts/archivo-latin-400-normal.woff2) format("woff2"); }
  @font-face { font-family: "Archivo"; font-weight: 500; src: url(/fonts/archivo-latin-500-normal.woff2) format("woff2"); }
  @font-face { font-family: "Archivo"; font-weight: 900; src: url(/fonts/archivo-latin-900-normal.woff2) format("woff2"); }
  @page { size: A4; margin: 18mm 18mm 20mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 400 10.5pt/1.55 Archivo, sans-serif; color: #444; }
  h1, h2, h3, b, strong { color: #1a1a1a; }
  a { color: #b5333f; text-decoration: none; }
  .cover { height: 255mm; display: flex; flex-direction: column; break-after: page; }
  .cover .top { display: flex; justify-content: space-between; align-items: center; }
  .cover img { height: 12mm; }
  .tag { font: 500 8pt Archivo; letter-spacing: .12em; text-transform: uppercase; color: #a89c9c; }
  .bar { width: 22mm; height: 1.6mm; background: #b5333f; margin-top: 60mm; }
  .cover h1 { font-weight: 900; font-size: 32pt; line-height: 1.08; margin: 7mm 0 5mm; }
  .cover p { font-size: 13pt; max-width: 150mm; margin: 0; }
  .cover .by { margin-top: auto; padding-top: 4mm; border-top: 1px solid #1a1a1a; display: flex; justify-content: space-between; font-size: 10pt; }
  .cover .by span:last-child { color: #b5333f; font-weight: 500; }
  h2 { font-weight: 900; font-size: 16pt; line-height: 1.2; margin: 9mm 0 3mm; break-after: avoid; }
  h3 { font-weight: 900; font-size: 12pt; margin: 6mm 0 2mm; break-after: avoid; }
  p { margin: 0 0 3mm; } ul, ol { padding-left: 6mm; margin: 0 0 3mm; } li { margin-bottom: 1.5mm; }
  li.tick { list-style: none; position: relative; } li.tick::before { content: ""; position: absolute; left: -6mm; top: .8mm; width: 3.2mm; height: 3.2mm; border: 1.4px solid #b5333f; border-radius: .6mm; }
  blockquote { margin: 4mm 0; padding: 3mm 5mm; border-left: 1.4mm solid #b5333f; background: #f6f3f3; }
  .end { margin-top: 10mm; padding: 6mm; background: #f6f3f3; border-left: 1.4mm solid #b5333f; break-inside: avoid; }
  .end p:last-child { margin: 0; }
</style></head><body>
  <section class="cover">
    <div class="top"><img src="/assets/logo.png" alt="Red Cherry IT"><span class="tag">Free guide · ${esc(date)}</span></div>
    <div class="bar"></div>
    <h1>${esc(m.title)}</h1>
    <p>${esc(m.summary)}</p>
    <div class="by"><span><b>David Hanmer</b>, Red Cherry IT</span><span>redcherryit.com</span></div>
  </section>
  ${body}
  <div class="end"><p><b>Want a hand with this?</b></p><p>Reply to the email this guide came with, or get in touch at <a href="${esc(SITE_URL)}/contact">redcherryit.com/contact</a> for a free, no obligation chat about your website.</p></div>
</body></html>`;
}

// The landing page, in the website's own layout (site/guide.html). Its form signs people up and names the guide.
export function landing(m: Magnet) {
  const vars: Record<string, string> = {
    title: esc(m.title), description: esc(m.summary), url: esc(pageUrl(m)), headline: esc(m.headline), pitch: inline(m.pitch),
    bullets: m.bullets.split('\n').map(b => b.trim()).filter(Boolean).map(b => `<li>${inline(b)}</li>`).join('\n            '),
    slug: esc(m.slug), subscribe: esc(`${PUBLIC_URL}/subscribe`),
  };
  return fs.readFileSync(SHELL, 'utf8').replace(/^<!--[\s\S]*?-->\n/, '').replace(/\{\{(\w+)\}\}/g, (k, n: string) => vars[n] ?? k);
}

// Makes the PDF, then puts the landing page on the site. Publishing again updates both.
export async function publish(id: number) {
  const m = row(id);
  if (m.status !== 'approved' && m.status !== 'published') fail(409, `Approve the guide before publishing. It is ${m.status}.`);
  if (!PUBLIC_URL) fail(503, 'Set PUBLIC_URL first: the landing page form and the download link need it');
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(pdfFile(m.slug), await pdf(guideHtml(m)));
  const published = await publishPage({ category: CATEGORY, slug: m.slug, title: m.title, summary: m.summary, date: new Date().toISOString().slice(0, 10) }, landing(m));
  db.prepare(`UPDATE magnets SET status = 'published', published_at = coalesce(published_at, datetime('now')), updated_at = datetime('now') WHERE id = ?`).run(id);
  return { ...get(id), published };
}

// Sends each guide someone asked for. Called once they have confirmed, or straight away if they were already on the list.
export async function deliver(email: string, slugs: string[]) {
  for (const g of slugs.map(live).filter((g): g is Magnet => !!g)) {
    await sendEmail({ to: email, subject: `Your free guide: ${g.title}`,
      text: `Hi,\n\nHere is your copy of ${g.title}:\n\n${pdfUrl(g)}\n\nIf you have any questions about it, just reply to this email.\n\nDavid Hanmer\nRed Cherry IT · redcherryit.com`,
      html: `<div style="font:16px/1.5 Arial,sans-serif;color:#1a1a1a;max-width:520px"><p style="color:#b5333f;font-weight:800">Red Cherry IT</p><p>Hi,</p>
<p>Here is your copy of <b>${esc(g.title)}</b>.</p>
<p><a href="${esc(pdfUrl(g))}" style="display:inline-block;padding:12px 20px;background:#b5333f;color:#fff;border-radius:8px;text-decoration:none;font-weight:700">Download the guide</a></p>
<p>If you have any questions about it, just reply to this email.</p><p>David Hanmer<br>Red Cherry IT</p></div>` });
  }
}
export const guidesIn = (tags: string) => tags.split(',').map(t => t.trim()).filter(t => t.startsWith('guide-')).map(t => t.slice(6));

// For outreach: the published guide a campaign offers, if any.
export function offer(campaignId: number | null) {
  const m = campaignId ? db.prepare(`SELECT m.* FROM magnets m JOIN campaigns c ON c.guide_id = m.id WHERE c.id = ? AND m.status = 'published'`).get(campaignId) as Magnet | undefined : undefined;
  return m ? `${m.title}: ${pageUrl(m)}` : 'none';
}
