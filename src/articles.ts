// Articles: Claude drafts, the app checks, David approves, the app publishes static files,
// then Claude writes a matching social post that waits in the Buffer approval queue.
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.ts';
import { fail, PUBLISH_DIR, SITE_URL } from './config.ts';
import { current as currentPrompt, parsePrompt, runPrompt, writeCopy } from './copy.ts';
import { readPage } from './page.ts';
import { toHtml } from './markdown.ts';
import { render } from './render.ts';
import * as posts from './posts.ts';

type Article = { id: number; slug: string; category: string; title: string; summary: string; body: string; topic: string; keyword: string; sources: string; status: string; published_at: string | null };
export type DraftInput = { topic: string; keyword?: string; audience?: string; sources?: string; url?: string; category?: string };

const get = (id: number) => (db.prepare('SELECT * FROM articles WHERE id = ?').get(id) as Article | undefined) ?? fail(404, `There is no article ${id}`);
const withChecks = (a: Article) => ({ ...a, url: articleUrl(a), checks: checks(a) });
const articleUrl = (a: Article) => `${SITE_URL}${a.category}${a.slug}`;

export const list = () => db.prepare(`SELECT id, slug, category, title, status, created_at, updated_at, published_at FROM articles ORDER BY id DESC LIMIT 200`).all();
export const show = (id: number) => withChecks(get(id));

const slugify = (s: string) => s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'article';
function freeSlug(base: string) {
  for (let i = 1; ; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    if (!db.prepare('SELECT 1 FROM articles WHERE slug = ?').get(slug)) return slug;
  }
}
const CATEGORY = /^\/([a-z0-9-]+\/)+$/;

// Plain rule checks, no AI. Errors stop approval; warnings are for David to look at.
export function checks(a: Pick<Article, 'body' | 'sources'>) {
  const rules = parsePrompt(currentPrompt('article').body).settings;
  const errors: string[] = [], warnings: string[] = [];
  const words = a.body.replace(/[#*_>\[\]()]/g, ' ').split(/\s+/).filter(Boolean).length;
  const min = Number(rules.min_words || 0), max = Number(rules.max_words || Infinity);
  if (words < min) errors.push(`It is ${words} words. The minimum is ${min}.`);
  if (words > max) errors.push(`It is ${words} words. The maximum is ${max}.`);
  const headings = [...a.body.matchAll(/^#{2,3}\s+(.+)$/gm)].map(m => m[1].trim().toLowerCase());
  for (const need of (rules.required_headings ?? '').split('|').map(h => h.trim()).filter(Boolean))
    if (!headings.some(h => h.startsWith(need.toLowerCase()))) errors.push(`There is no "${need}" heading.`);
  if (!a.sources.trim()) errors.push('There are no sources, so nothing in it can be checked.');
  const marks = a.body.match(/\[SOURCE NEEDED\]/g)?.length ?? 0;
  if (marks) errors.push(`${marks} claim${marks > 1 ? 's are' : ' is'} marked [SOURCE NEEDED]. Add a source or remove the claim.`);
  const dashes = a.body.split('\n').filter(l => /[—–]| - /.test(l));
  if (dashes.length) errors.push(`Dashes used as punctuation: "${dashes[0].trim().slice(0, 80)}"${dashes.length > 1 ? ` and ${dashes.length - 1} more` : ''}.`);
  // A figure that is not in the sources may be made up.
  const sourceText = a.sources.replace(/,/g, '');
  const figures = new Set((a.body.match(/£?\d[\d,.]*%?/g) ?? []).map(f => f.replace(/,/g, '').replace(/\.$/, '')));
  for (const f of figures) if (!sourceText.includes(f.replace(/^£/, '').replace(/%$/, ''))) warnings.push(`${f} does not appear in the sources. Check it is right.`);
  const quotes = a.body.match(/"[^"\n]{20,}"/g) ?? [];
  for (const q of quotes) if (!a.sources.includes(q.slice(1, 40))) warnings.push(`The quote ${q.slice(0, 50)}..." does not appear in the sources.`);
  return { words, errors, warnings };
}

export async function draft(input: DraftInput) {
  const category = input.category || '/guides/stories/';
  if (!CATEGORY.test(category)) fail(400, 'category must look like /guides/stories/');
  const page = input.url ? await readPage(input.url) : undefined;
  const sources = [input.sources?.trim(), page && `From ${page.url}\nTitle: ${page.title}\n\n${page.text}`].filter(Boolean).join('\n\n');
  if (!sources) fail(400, 'Give some sources or a page link. Articles only use facts from their sources.');
  const run = await runPrompt('article', { ...input, sources } as Record<string, string>, { job: 'article:draft' });
  const o = run.output as { title: string; summary: string; body: string };
  const r = db.prepare(`INSERT INTO articles (slug, category, title, summary, body, topic, keyword, sources, status)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft')`)
    .run(freeSlug(slugify(o.title)), category, o.title.trim(), o.summary.trim(), o.body.trim(), input.topic, input.keyword ?? '', sources);
  return { ...show(Number(r.lastInsertRowid)), cost_gbp: run.cost_gbp };
}

// David's edits. Only drafts can change, so what was approved is what gets published.
export function update(id: number, e: { title?: string; summary?: string; body?: string; slug?: string; category?: string; sources?: string }) {
  const a = get(id);
  if (a.status !== 'draft') fail(409, `Only a draft can be edited. This one is ${a.status}.`);
  if (e.category && !CATEGORY.test(e.category)) fail(400, 'category must look like /guides/stories/');
  if (e.slug !== undefined && (slugify(e.slug) !== e.slug || db.prepare('SELECT 1 FROM articles WHERE slug = ? AND id != ?').get(e.slug, id)))
    fail(400, 'slug must be lowercase words joined by hyphens, and not used by another article');
  db.prepare(`UPDATE articles SET title = ?, summary = ?, body = ?, slug = ?, category = ?, sources = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(e.title ?? a.title, e.summary ?? a.summary, e.body ?? a.body, e.slug ?? a.slug, e.category ?? a.category, e.sources ?? a.sources, id);
  return show(id);
}

export function approve(id: number) {
  const a = get(id);
  if (a.status !== 'draft') fail(409, `Only a draft can be approved. This one is ${a.status}.`);
  const c = checks(a);
  if (c.errors.length) fail(422, `Fix these first: ${c.errors.join(' ')}`);
  db.prepare(`UPDATE articles SET status = 'approved', updated_at = datetime('now') WHERE id = ?`).run(id);
  return show(id);
}

export function reject(id: number) {
  const r = db.prepare(`UPDATE articles SET status = 'rejected', updated_at = datetime('now') WHERE id = ? AND status IN ('draft', 'approved')`).run(id);
  if (!r.changes) fail(409, `Article ${id} cannot be rejected now (it is ${get(id).status})`);
  return show(id);
}

// Back to draft for more changes. A published article stays on the site until it is published again.
export function reopen(id: number) {
  const r = db.prepare(`UPDATE articles SET status = 'draft', updated_at = datetime('now') WHERE id = ? AND status IN ('approved', 'rejected', 'published')`).run(id);
  if (!r.changes) fail(409, 'That article is already a draft');
  return show(id);
}

export function files(a: Article, date: string) {
  const md = `---\nCategory: ${a.category}\nSlug: ${a.slug}\nTitle: ${a.title}\nSummary: ${a.summary}\nLast updated: ${date}\n---\n\n${a.body}\n`;
  const html = `<!-- ${a.category}${a.slug} | ${a.title.replace(/--/g, '')} | Last updated ${date} -->\n<article>\n${toHtml(a.body)}\n</article>\n`;
  return { md, html };
}

// Writes the Markdown and an HTML fragment for the static site. Publishing again overwrites the same files.
export function publish(id: number) {
  const a = get(id);
  if (a.status !== 'approved' && a.status !== 'published') fail(409, `Approve the article before publishing. It is ${a.status}.`);
  const date = new Date().toISOString().slice(0, 10);
  const dir = path.join(PUBLISH_DIR, ...a.category.split('/').filter(Boolean));
  fs.mkdirSync(dir, { recursive: true });
  const f = files(a, date);
  fs.writeFileSync(path.join(dir, `${a.slug}.md`), f.md);
  fs.writeFileSync(path.join(dir, `${a.slug}.html`), f.html);
  db.prepare(`UPDATE articles SET status = 'published', published_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
  return { ...show(id), files: [`${a.category}${a.slug}.md`, `${a.category}${a.slug}.html`] };
}

export function download(id: number, format: 'md' | 'html') {
  const a = get(id);
  return files(a, (a.published_at ?? new Date().toISOString()).slice(0, 10))[format];
}

// One social post per template for a published article, added to the Buffer approval queue.
// The same article and template always give the same posts, and Claude is not asked twice.
export async function social(id: number, p: { template: string; channels: posts.PostInput['channels']; mode: posts.PostInput['mode']; due_at?: string }) {
  const a = get(id);
  if (a.status !== 'published') fail(409, 'Publish the article before making social posts for it');
  const key = `article-${id}-${p.template}`;
  if (db.prepare('SELECT 1 FROM posts WHERE idempotency_key = ?').get(key)) return { posts: db.prepare('SELECT * FROM posts WHERE idempotency_key = ? ORDER BY id').all(key), cost_gbp: 0, reused: true };
  const copy = await writeCopy({ template: p.template, topic: `Promote this article so people click through to read it: "${a.title}". ${a.summary}`, keyword: a.keyword, sources: a.body });
  if (!copy.fits) fail(422, 'Claude could not make the text fit this template. Try another template.');
  const r = await render(p.template, copy.fields);
  if (!r.ok) return fail(422, 'The text does not fit this template');
  const text = [copy.caption, articleUrl(a), copy.hashtags.join(' ')].join('\n\n');
  const made = await posts.create({ render_id: r.id, channels: p.channels, text, mode: p.mode, due_at: p.due_at, idempotency_key: key });
  return { posts: made, fields: copy.fields, cost_gbp: copy.cost_gbp, reused: false };
}
