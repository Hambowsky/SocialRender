// Publishing to the website. With SITE_REPO set, the page, its listing card and its sitemap entry go into
// the website's GitHub repo as one commit (with the hub page's guide count), and the host deploys from there. Without it, the page is written
// to PUBLISH_DIR to upload by hand.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fail, GITHUB_API_URL, PUBLISH_DIR, SITE_BRANCH, SITE_GITHUB_TOKEN, SITE_REPO, SITE_URL } from './config.ts';
import { esc } from './markdown.ts';

export type Listing = { category: string; slug: string; title: string; summary: string; date: string };
// A Buffer is a binary file such as an image.
export type File = { path: string; content: string | Buffer };

async function gh(method: string, url: string, body?: unknown) {
  const res = await fetch(`${GITHUB_API_URL}/repos/${SITE_REPO}${url}`, {
    method,
    headers: { authorization: `Bearer ${SITE_GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404 && method === 'GET') return undefined;
  if (!res.ok) fail(502, `GitHub said ${res.status}: ${(await res.json().catch(() => ({}))).message ?? ''}`.trim());
  return res.json();
}

async function readRepoFile(p: string, ref: string): Promise<string | undefined> {
  const f = await gh('GET', `/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`);
  return f && Buffer.from(f.content, 'base64').toString('utf8');
}

// Git's own id for a file, so an unchanged image is never uploaded again.
const blobSha = (b: Buffer) => crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
const repoSha = async (p: string, ref: string): Promise<string | undefined> =>
  (await gh('GET', `/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`))?.sha;

// Adds the article's card to the end of its category listing, once.
export function addCard(index: string, l: Listing) {
  if (index.includes(`href="${l.slug}"`)) return index;
  const start = index.indexOf('<div class="guide-list">');
  const end = index.indexOf('\n      </div>', start);
  if (start < 0 || end < 0) return index;
  const tag = esc(l.category.split('/').filter(Boolean).at(-1)!.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()));
  const card = `\n        <a class="guide-card" href="${l.slug}">\n          <span class="guide-card-tag">${tag}</span>\n          <h3>${esc(l.title)}</h3>\n          <p>${esc(l.summary)}</p>\n        </a>`;
  return index.slice(0, end) + card + index.slice(end);
}

// Sets the "N guides" count on the hub page card for this category (guides/index.html links to it by folder name).
export function setHubCount(hub: string, category: string, count: number) {
  const folder = category.split('/').filter(Boolean).at(-1)!;
  const start = hub.indexOf(`<a class="guide-card" href="${folder}">`);
  if (start < 0) return hub;
  const end = hub.indexOf('</a>', start);
  const card = hub.slice(start, end).replace(/(<span class="guide-card-count)[^"]*(">)[^<]*/, `$1$2${count} guide${count === 1 ? '' : 's'}`);
  return hub.slice(0, start) + card + hub.slice(end);
}

// Adds the page to the sitemap after the rest of its category, or updates its date.
export function addToSitemap(xml: string, l: Listing) {
  const loc = `${SITE_URL}${l.category}${l.slug}`;
  const line = `  <url><loc>${loc}</loc><lastmod>${l.date}</lastmod><changefreq>monthly</changefreq><priority>0.6</priority></url>`;
  const lines = xml.split('\n');
  const at = lines.findIndex(x => x.includes(`<loc>${loc}</loc>`));
  if (at >= 0) { lines[at] = lines[at].replace(/<lastmod>[^<]*<\/lastmod>/, `<lastmod>${l.date}</lastmod>`); return lines.join('\n'); }
  const sameCategory = lines.map((x, i) => x.includes(`<loc>${SITE_URL}${l.category.replace(/\/$/, '')}`) ? i : -1).filter(i => i >= 0);
  const after = sameCategory.length ? sameCategory.at(-1)! : lines.findIndex(x => x.includes('</urlset>')) - 1;
  lines.splice(after + 1, 0, line);
  return lines.join('\n');
}

// One commit with every file that changed. If someone pushes in between, it rebuilds from their commit once.
async function commit(build: (head: string) => Promise<File[]>, message: string) {
  for (let attempt = 0; ; attempt++) {
    const head = (await gh('GET', `/git/ref/heads/${SITE_BRANCH}`))?.object.sha ?? fail(502, `The ${SITE_BRANCH} branch was not found in ${SITE_REPO}`);
    const files = await build(head);
    const old = await Promise.all(files.map(f => Buffer.isBuffer(f.content) ? repoSha(f.path, head) : readRepoFile(f.path, head)));
    const changed = files.filter((f, i) => old[i] !== (Buffer.isBuffer(f.content) ? blobSha(f.content) : f.content));
    const tree = await Promise.all(changed.map(async f => Buffer.isBuffer(f.content)
      ? { path: f.path, mode: '100644', type: 'blob', sha: (await gh('POST', '/git/blobs', { content: f.content.toString('base64'), encoding: 'base64' })).sha }
      : { path: f.path, mode: '100644', type: 'blob', content: f.content }));
    if (!tree.length) return { commit: head, changed: [] as string[] };
    const base = await gh('GET', `/git/commits/${head}`);
    const t = await gh('POST', '/git/trees', { base_tree: base.tree.sha, tree });
    const c = await gh('POST', '/git/commits', { message, tree: t.sha, parents: [head] });
    try {
      await gh('PATCH', `/git/refs/heads/${SITE_BRANCH}`, { sha: c.sha, force: false });
      return { commit: c.sha as string, changed: tree.map(x => x.path) };
    } catch (err) {
      if (attempt >= 1) throw err;
    }
  }
}

// Pages already on the site in one category folder, by slug.
export async function sitePages(category: string): Promise<string[]> {
  const dir = category.replace(/^\/|\/$/g, '');
  const names: string[] = SITE_REPO
    ? ((await gh('GET', `/contents/${dir}?ref=${SITE_BRANCH}`)) ?? []).map((f: { name: string }) => f.name)
    : fs.existsSync(path.join(PUBLISH_DIR, dir)) ? fs.readdirSync(path.join(PUBLISH_DIR, dir)) : [];
  return names.filter(n => n.endsWith('.html') && n !== 'index.html').map(n => n.slice(0, -5)).sort();
}

export async function sitePage(category: string, slug: string) {
  const file = `${category.replace(/^\/|\/$/g, '')}/${slug}.html`;
  if (SITE_REPO) return readRepoFile(file, SITE_BRANCH);
  const local = path.join(PUBLISH_DIR, ...file.split('/'));
  return fs.existsSync(local) ? fs.readFileSync(local, 'utf8') : undefined;
}

// The guides listed on a category's index page, for picking Related Reading.
// ponytail: five minute cache per category, since the preview asks on every look; publishing adds its own card anyway.
const cardCache = new Map<string, { at: number; cards: { category: string; slug: string; title: string; summary: string }[] }>();
export async function guideCards(category: string) {
  const hit = cardCache.get(category);
  if (hit && Date.now() - hit.at < 300_000) return hit.cards;
  const file = `${category.replace(/^\/|\/$/g, '')}/index.html`;
  const html = SITE_REPO ? await readRepoFile(file, SITE_BRANCH) : fs.existsSync(path.join(PUBLISH_DIR, file)) ? fs.readFileSync(path.join(PUBLISH_DIR, file), 'utf8') : undefined;
  const cards = [...(html ?? '').matchAll(/<a class="guide-card" href="([^"]+)">[\s\S]*?<h3>([\s\S]*?)<\/h3>\s*(?:<p>([\s\S]*?)<\/p>)?/g)]
    .map(m => ({ category, slug: m[1], title: m[2].trim(), summary: (m[3] ?? '').trim() }));
  cardCache.set(category, { at: Date.now(), cards });
  return cards;
}

// A page that is already live keeps its own Related Reading cards and banner heading when published again,
// unless they are still the three general cards every new page started with.
export const RELATED = /<div class="related-grid[\s\S]*?\n {6}<\/div>/;
const GENERIC = /href="\.\.\/\.\.\/case-studies"[\s\S]*href="\.\.\/\.\.\/industries"[\s\S]*href="\.\.\/\.\.\/pricing"/;
const CTA_HEADING = /(<div class="cta-banner[^"]*">\s*<h2>)[\s\S]*?(<\/h2>)/;
export function keepExtras(html: string, old: string | undefined) {
  if (!old) return html;
  const related = old.match(RELATED)?.[0], heading = old.match(CTA_HEADING);
  if (related && !GENERIC.test(related)) html = html.replace(RELATED, () => related);
  if (heading) html = html.replace(CTA_HEADING, (_, a, b) => a + old.match(CTA_HEADING)![0].slice(heading[1].length, -heading[2].length) + b);
  return html;
}

// `extra` is any other file the page needs, such as its featured image, at its path from the site root.
export async function publishPage(l: Listing, html: string, extra: File[] = []) {
  const dir = l.category.replace(/^\/|\/$/g, '');
  if (!SITE_REPO) {
    for (const f of extra) {
      fs.mkdirSync(path.dirname(path.join(PUBLISH_DIR, f.path)), { recursive: true });
      fs.writeFileSync(path.join(PUBLISH_DIR, f.path), f.content);
    }
    const out = path.join(PUBLISH_DIR, ...dir.split('/'));
    fs.mkdirSync(out, { recursive: true });
    const file = path.join(out, `${l.slug}.html`);
    fs.writeFileSync(file, keepExtras(html, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined));
    return { where: 'folder', files: [`${l.category}${l.slug}.html`, ...extra.map(f => `/${f.path}`)] };
  }
  if (!SITE_GITHUB_TOKEN) fail(503, 'SITE_GITHUB_TOKEN is not set, so the site repo cannot be updated');
  const r = await commit(async head => {
    const page = `${dir}/${l.slug}.html`;
    const files: File[] = [{ path: page, content: keepExtras(html, await readRepoFile(page, head)) }, ...extra];
    const index = await readRepoFile(`${dir}/index.html`, head);
    if (index) {
      const updated = addCard(index, l);
      files.push({ path: `${dir}/index.html`, content: updated });
      const hubPath = `${dir.split('/').slice(0, -1).join('/')}/index.html`;
      const hub = dir.includes('/') ? await readRepoFile(hubPath, head) : undefined;
      if (hub) files.push({ path: hubPath, content: setHubCount(hub, l.category, updated.match(/class="guide-card"/g)!.length) });
    }
    const sitemap = await readRepoFile('sitemap.xml', head);
    if (sitemap) files.push({ path: 'sitemap.xml', content: addToSitemap(sitemap, l) });
    return files;
  }, `Publish ${l.title}`);
  return { where: 'repo', commit: `https://github.com/${SITE_REPO}/commit/${r.commit}`, files: r.changed };
}
