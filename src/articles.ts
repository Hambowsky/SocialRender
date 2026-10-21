// Articles: Claude drafts, the app checks, David approves, the app publishes static files,
// then Claude writes a matching social post that waits in the Buffer approval queue.
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.ts';
import { fail, ROOT, SITE_URL } from './config.ts';
import { current as currentPrompt, fillPromptVars, list as listPrompts, parsePrompt, runPrompt, systemPrompt, writeCopy } from './copy.ts';
import { ask } from './claude.ts';
import { readPage } from './page.ts';
import { esc, fromHtml, inline, toHtml, unesc } from './markdown.ts';
import { render } from './render.ts';
import * as posts from './posts.ts';
import { publishPage, sitePage, sitePages } from './site.ts';

type Article = { id: number; slug: string; category: string; title: string; summary: string; body: string; topic: string; keyword: string; sources: string; status: string; published_at: string | null };
export type DraftInput = { topic: string; keyword?: string; audience?: string; sources?: string; url?: string; category?: string };

const get = (id: number) => (db.prepare('SELECT * FROM articles WHERE id = ?').get(id) as Article | undefined) ?? fail(404, `There is no article ${id}`);
const withChecks = (a: Article) => ({ ...a, url: articleUrl(a), checks: checks(a) });
const articleUrl = (a: Article) => `${SITE_URL}${a.category}${a.slug}`;

export const list = () => db.prepare(`SELECT id, slug, category, title, status, created_at, updated_at, published_at FROM articles ORDER BY id DESC LIMIT 200`).all();
export const show = (id: number) => withChecks(get(id));

// One category: the tool's own articles, then pages already on the site that have not been opened here yet.
export async function inCategory(category: string) {
  checkCategory(category);
  const mine = db.prepare(`SELECT id, slug, category, title, status FROM articles WHERE category = ? ORDER BY id DESC`).all(category) as { slug: string; title: string }[];
  const known = new Set((db.prepare('SELECT slug FROM articles').all() as { slug: string }[]).map(a => a.slug));
  const site = (await sitePages(category)).filter(s => !known.has(s))
    .map(slug => ({ slug, category, title: slug.replace(/-/g, ' ').replace(/^\w/, c => c.toUpperCase()), status: 'on_site' }));
  return [...mine, ...site];
}

const between = (html: string, from: RegExp, to: string) => {
  const m = from.exec(html);
  return m ? html.slice(m.index + m[0].length, html.indexOf(to, m.index + m[0].length)) : '';
};
const textOf = (h: string) => unesc(h.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

const str = { type: 'string' };
const IDEAS = {
  type: 'object', additionalProperties: false, required: ['ideas'],
  properties: { ideas: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['title', 'keyword', 'angle', 'audience', 'notes', 'sources'],
    properties: { title: str, keyword: str, angle: str, audience: str, notes: str,
      sources: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'url'], properties: { title: str, url: str } } } } } } },
};

// Article ideas for a category, from Claude searching the web. It sees the section's structure and
// what is already there, so it does not repeat them. Nothing is saved; picking an idea fills the draft form.
export async function research(category: string, input: { focus?: string; audience?: string }) {
  checkCategory(category);
  const p = parsePrompt(currentPrompt('research').body);
  const existing = (await inCategory(category)).map(a => `* ${a.title}`).join('\n');
  const structure = parsePrompt(currentPrompt(promptFor(category)).body).text.match(/^.*structure[\s\S]*?(?=\n\n)/mi)?.[0] ?? '';
  const vars = { category, section: sectionName(category), structure, existing, focus: input.focus ?? '', audience: input.audience || 'UK business owners' };
  const r = await ask({ job: 'article:research', model: p.model, effort: p.effort, maxTokens: p.maxTokens, system: systemPrompt(),
    messages: [{ role: 'user', content: fillPromptVars(p.text, vars) }], schema: IDEAS, webSearches: Math.min(Number(p.settings.web_searches || 5), 10) });
  if (!Array.isArray(r.output?.ideas)) fail(502, 'Claude did not return any ideas. Try again');
  // Only web links count as sources; an idea left with none is shown flagged.
  const ideas = r.output.ideas.map((i: any) => ({ ...i, sources: (i.sources ?? []).filter((s: any) => /^https?:\/\//.test(s?.url)) }));
  return { ideas, cost_gbp: r.cost_gbp };
}

const FACTS = {
  type: 'object', additionalProperties: false, required: ['facts'],
  properties: { facts: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['fact', 'source_title', 'url', 'date'], properties: { fact: str, source_title: str, url: str, date: str } } } },
};

// Facts for one topic, each with the page it came from, from Claude searching the web. The text goes
// straight into the draft's sources, so a fact without a web link is dropped rather than passed on.
export async function findSources(category: string, input: { topic: string; keyword?: string; audience?: string }) {
  checkCategory(category);
  const p = parsePrompt(currentPrompt('sources').body);
  const vars = { category, section: sectionName(category), topic: input.topic, keyword: input.keyword ?? '', audience: input.audience || 'UK business owners' };
  const r = await ask({ job: 'article:sources', model: p.model, effort: p.effort, maxTokens: p.maxTokens, system: systemPrompt(),
    messages: [{ role: 'user', content: fillPromptVars(p.text, vars) }], schema: FACTS, webSearches: Math.min(Number(p.settings.web_searches || 6), 10) });
  if (!Array.isArray(r.output?.facts)) fail(502, 'Claude did not return any sources. Try again');
  const facts = r.output.facts.filter((f: any) => f?.fact && /^https?:\/\//.test(f.url));
  if (!facts.length) fail(502, 'Claude could not find sources it could link to. Try a more specific topic');
  const text = facts.map((f: any) => `* ${f.fact} (${f.source_title}${f.date ? `, ${f.date}` : ''}: ${f.url})`).join('\n');
  return { facts, text, cost_gbp: r.cost_gbp };
}

// Every guide that is live, across all categories, for picking one to make a social post from.
export async function live() {
  const all = await Promise.all(categories().map(c => inCategory(c.category)));
  return all.flat().filter((a: any) => a.status === 'published' || a.status === 'on_site')
    .map((a: any) => ({ title: a.title, category: a.category, url: `${SITE_URL}${a.category}${a.slug}` }));
}

// Brings a live page into the tool as a published article, so it can be edited and published again.
// Its own text becomes its sources, so the checks compare edits with what was live.
export async function importPage(category: string, slug: string) {
  checkCategory(category);
  if (!/^[a-z0-9-]{1,120}$/.test(slug)) fail(400, 'That is not a page name');
  const existing = db.prepare('SELECT id FROM articles WHERE slug = ?').get(slug) as { id: number } | undefined;
  if (existing) return show(existing.id);
  const html = await sitePage(category, slug) ?? fail(404, `There is no ${category}${slug} page on the site`);
  const url = `${SITE_URL}${category}${slug}`;
  const title = textOf(between(html, /<h1[^>]*>/, '</h1>')) || slug;
  const summary = unesc(html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? '');
  const answer = fromHtml(`<p>${between(html, /<div class="answer-box">/, '</div>').replace(/<strong>Short answer:<\/strong>/i, '')}</p>`, url);
  const content = fromHtml(between(html, /<div class="article-body">/, '</section>'), url);
  const cta = textOf(between(html, /<div class="cta-banner[^"]*">[\s\S]*?<p>/, '</p>'));
  const body = [`# ${title}`, answer, content, cta && `*${cta}*`].filter(Boolean).join('\n\n');
  const published = html.match(/"datePublished":\s*"(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
  const r = db.prepare(`INSERT INTO articles (slug, category, title, summary, body, topic, keyword, sources, status, published_at)
                        VALUES (?, ?, ?, ?, ?, ?, '', ?, 'published', ?)`)
    .run(slug, category, title, summary, body, title, `Imported from ${url}\n\n${body}`, published);
  return show(Number(r.lastInsertRowid));
}

const slugify = (s: string) => s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'article';
function freeSlug(base: string) {
  for (let i = 1; ; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    if (!db.prepare('SELECT 1 FROM articles WHERE slug = ?').get(slug)) return slug;
  }
}
const CATEGORY = /^\/([a-z0-9-]+\/)+$/;

// Each category has its own structure prompt, article-<last folder>, e.g. article-learn for /guides/learn/.
// Adding a prompt with that name in the Prompts section adds the category.
const promptFor = (category: string) => `article-${category.split('/').filter(Boolean).at(-1)}`;
// The name shown in the breadcrumb, from the prompt's section setting, else the folder name.
const sectionName = (category: string) => {
  const folder = category.split('/').filter(Boolean).at(-1)!;
  const p = categoryPrompt(category);
  return (p && parsePrompt(p.body).settings.section) || folder.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
};
const categoryPrompt = (category: string) => { try { return currentPrompt(promptFor(category)); } catch { return undefined; } };
export const categories = () => (listPrompts() as { name: string }[])
  .filter(p => p.name.startsWith('article-'))
  .map(p => `/guides/${p.name.slice(8)}/`)
  .map(category => ({ category, label: sectionName(category) }));
function checkCategory(category: string) {
  if (!CATEGORY.test(category)) fail(400, 'category must look like /guides/stories/');
  if (!categories().some(c => c.category === category)) fail(400, `There is no ${promptFor(category)} prompt, so ${category} has no article structure yet`);
}

// Plain rule checks, no AI. Errors stop approval; warnings are for David to look at.
export function checks(a: Pick<Article, 'body' | 'sources' | 'category'>) {
  const rules = parsePrompt(currentPrompt(promptFor(a.category)).body).settings;
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
  checkCategory(category);
  const page = input.url ? await readPage(input.url) : undefined;
  const sources = [input.sources?.trim(), page && `From ${page.url}\nTitle: ${page.title}\n\n${page.text}`].filter(Boolean).join('\n\n');
  if (!sources) fail(400, 'Give some sources or a page link. Articles only use facts from their sources.');
  const run = await runPrompt(promptFor(category), { ...input, sources } as Record<string, string>, { job: 'article:draft' });
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
  if (e.category) checkCategory(e.category);
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

const SHELL = path.join(ROOT, 'site', 'article.html');
const plain = (md: string) => md.replace(/\*\*|\*|`/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();
const json = (v: unknown) => JSON.stringify(v, null, 2).replace(/</g, '\\u003c');
const DEFAULT_CTA = 'Want something similar for your business? Get in touch for a fixed price quote.';

// The full page in the same layout as the live story pages (site/article.html): the opening paragraph
// becomes the short answer box, the closing call to action goes in the banner, and FAQs get their schema.
export function page(a: Pick<Article, 'title' | 'summary' | 'body' | 'category' | 'slug'>, date: string, published = date) {
  const blocks = a.body.replace(/\r/g, '').split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  if (blocks[0]?.startsWith('# ')) blocks.shift();
  const shortAnswer = blocks[0] && !blocks[0].startsWith('#') ? blocks.shift()! : a.summary;
  let cta = '';
  // Trailing rule and italic lines are the call to action (the last one) and notes for David, not page content.
  while (blocks.length && /^(-{3,}|\*[^*][\s\S]*\*)$/.test(blocks.at(-1)!)) {
    const b = blocks.pop()!;
    if (!cta && b.startsWith('*')) cta = plain(b);
  }
  cta ||= DEFAULT_CTA;
  const faqs: { q: string; a: string }[] = [];
  const faqStart = blocks.findIndex(b => /^##\s+FAQs?/i.test(b));
  const out = blocks.map((b, i) => {
    const m = faqStart >= 0 && i > faqStart && b.match(/^\*\*(.+?)\*\*\s*\n([\s\S]+)$/);
    if (!m) return b;
    faqs.push({ q: plain(m[1]), a: plain(m[2]) });
    return `### ${m[1]}\n\n${m[2]}`;
  });
  const url = `${SITE_URL}${a.category}${a.slug}`;
  const sectionUrl = `${SITE_URL}${a.category.replace(/\/$/, '')}`;
  const section = sectionName(a.category);
  const vars: Record<string, string> = {
    title: esc(a.title), description: esc(a.summary), url: esc(url), section: esc(section),
    folder: esc(a.category.split('/').filter(Boolean).at(-1)!.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())), section_url: esc(sectionUrl),
    short_answer: inline(shortAnswer.replace(/\n/g, ' ')), cta: esc(cta), year: date.slice(0, 4),
    updated_month: new Date(date + 'T12:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    body: toHtml(out.join('\n\n')).split('\n').map(l => l && '        ' + l).join('\n'),
    article_schema: json({
      '@context': 'https://schema.org', '@type': 'Article', headline: a.title, description: a.summary,
      image: 'https://redcherryit.com/images/og-image.png',
      author: { '@type': 'Person', name: 'David Hanmer', url: 'https://redcherryit.com/about' },
      publisher: { '@type': 'Organization', name: 'Red Cherry IT', logo: { '@type': 'ImageObject', url: 'https://redcherryit.com/images/logo.png' } },
      datePublished: published, dateModified: date, mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    }),
    faq_schema: faqs.length ? `<script type="application/ld+json">\n${json({ '@context': 'https://schema.org', '@type': 'FAQPage',
      mainEntity: faqs.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) })}\n</script>` : '',
    breadcrumb_schema: json({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      ['Home', `${SITE_URL}/`], ['Guides', `${SITE_URL}/guides`], [section, sectionUrl], [a.title, url],
    ].map(([name, item], i) => ({ '@type': 'ListItem', position: i + 1, name, item })) }),
  };
  return fs.readFileSync(SHELL, 'utf8').replace(/^<!--[\s\S]*?-->\n/, '').replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m);
}

// Front matter like David's example, for keeping a copy. It is never put on the site.
const markdown = (a: Article, date: string) =>
  `---\nCategory: ${a.category}\nSlug: ${a.slug}\nTitle: ${a.title}\nSummary: ${a.summary}\nLast updated: ${date}\n---\n\n${a.body}\n`;

const today = () => new Date().toISOString().slice(0, 10);
const firstPublished = (a: Article) => a.published_at?.slice(0, 10) ?? today();

// Puts the finished page on the site (see site.ts). Publishing again updates the same page.
export async function publish(id: number) {
  const a = get(id);
  if (a.status !== 'approved' && a.status !== 'published') fail(409, `Approve the article before publishing. It is ${a.status}.`);
  const date = today();
  const result = await publishPage({ category: a.category, slug: a.slug, title: a.title, summary: a.summary, date }, page(a, date, firstPublished(a)));
  db.prepare(`UPDATE articles SET status = 'published', published_at = COALESCE(published_at, datetime('now')), updated_at = datetime('now') WHERE id = ?`).run(id);
  return { ...show(id), published: result };
}

export function download(id: number, format: 'md' | 'html') {
  const a = get(id);
  return format === 'md' ? markdown(a, today()) : page(a, today(), firstPublished(a));
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
