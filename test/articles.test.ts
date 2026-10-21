// Articles against a fake Claude and a fake Buffer, so tests cost nothing and post nothing.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { sendStream } from './sse.ts';

process.env.NODE_ENV = 'test';
process.env.API_KEY = 'test-key';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rct-articles-'));
process.env.ANTHROPIC_API_KEY = 'fake';
process.env.BUFFER_API_KEY = 'fake';
process.env.PUBLIC_URL = 'https://tool.example.com';
process.env.SITE_REPO = 'me/site';
process.env.SITE_GITHUB_TOKEN = 'fake';

// The voice example is a real article in the right structure, so it doubles as Claude's draft and its sources.
const example = fs.readFileSync(path.join(import.meta.dirname, '..', 'prompts', 'examples', 'financial-services-portal.md'), 'utf8');
const exampleBody = example.replace(/^---[\s\S]*?---\n+/, '').replace(/\n---\n[\s\S]*$/, '\n\n*Want something similar for your business? Get in touch for a fixed price quote.*');
const sources = 'Payments business, news portal. ' + example;

const claudeCalls: string[] = [];
const serve = (handler: (body: any) => unknown, stream = false) => http.createServer((req, res) => {
  let b = '';
  req.on('data', c => (b += c));
  req.on('end', () => {
    const out = handler(JSON.parse(b));
    if (stream) return sendStream(res, out);
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(out));
  });
});
const researchCalls: any[] = [];
const claude = serve(r => {
  const prompt = JSON.stringify(r.messages);
  if (prompt.includes('Find sources for a Red Cherry IT guide')) {
    researchCalls.push(r);
    const facts = [{ fact: 'Most brochure sites take four to six weeks.', source_title: 'Timelines', url: 'https://example.co.uk/timelines', date: '2026' },
      { fact: 'A made up figure with no page.', source_title: 'Nowhere', url: '', date: '' }];
    return { id: 'msg', type: 'message', role: 'assistant', model: r.model, stop_reason: 'end_turn', stop_sequence: null, stop_details: null,
      content: [{ type: 'text', text: JSON.stringify({ facts }) }], usage: { input_tokens: 4000, output_tokens: 500, server_tool_use: { web_search_requests: 3 } } };
  }
  if (prompt.includes('Suggest article ideas')) {
    researchCalls.push(r);
    const base = { id: 'msg', type: 'message', role: 'assistant', model: r.model, stop_sequence: null, stop_details: null };
    // The first round pauses mid search, as the API can, so the tool has to send it back to carry on.
    if (!r.messages.some((m: any) => m.role === 'assistant')) return { ...base, stop_reason: 'pause_turn',
      content: [{ type: 'server_tool_use', id: 'srv1', name: 'web_search', input: { query: 'uk website questions 2026' } }],
      usage: { input_tokens: 2000, output_tokens: 100, server_tool_use: { web_search_requests: 1 } } };
    const ideas = [{ title: 'How long does a website take to build?', keyword: 'website build time', angle: 'Owners ask this before they budget.', audience: 'UK business owners',
      notes: 'Most brochure sites take four to six weeks (https://example.co.uk/timelines)', sources: [{ title: 'Timelines', url: 'https://example.co.uk/timelines' }] }];
    return { ...base, stop_reason: 'end_turn', content: [{ type: 'text', text: 'Here you go.\n' + JSON.stringify({ ideas }) }],
      usage: { input_tokens: 5000, output_tokens: 800, server_tool_use: { web_search_requests: 2 } } };
  }
  if (prompt.includes('Red Cherry IT explainer')) claudeCalls.push('learn');
  claudeCalls.push(prompt.includes('Red Cherry IT article') ? 'article' : prompt.includes('Write the caption') ? 'caption' : 'post');
  const out = /Red Cherry IT (article|explainer)/.test(prompt)
    ? { title: 'Building an Information Portal for a Financial Services Business', summary: 'How we built a portal that publishes three articles a week.', body: exampleBody }
    : prompt.includes('Write the caption')
    ? { caption: 'How a payments business publishes three articles a week without a developer.', hashtags: ['#WebDesign', '#SEO', '#ContentMarketing'] }
    : { headline: 'Three articles a week', highlight_word: 'Three', subtitle: 'A portal the team runs themselves.', tag: 'Case Study', footer_left: 'Read the story' };
  return { id: 'msg', type: 'message', role: 'assistant', model: r.model, stop_reason: 'end_turn', stop_sequence: null, stop_details: null,
    content: [{ type: 'text', text: JSON.stringify(out) }], usage: { input_tokens: 3000, output_tokens: 1500 } };
}, true);
const bufferSent: string[] = [];
const buffer = serve(({ query }) => (bufferSent.push(query), { data: { createPost: { post: { id: 'b1' } } } }));

// A fake GitHub holding a tiny copy of the website repo.
const repo: Record<string, string> = {
  'guides/index.html': '<a class="guide-card" href="stories">\n<h3>Stories</h3>\n<span class="guide-card-count">1 guide</span>\n</a>\n<a class="guide-card" href="tools">\n<span class="guide-card-count guide-card-count--soon">Coming soon</span>\n</a>',
  'guides/stories/index.html': '<main>\n      <div class="guide-list">\n        <a class="guide-card" href="older-story">\n        </a>\n      </div>\n</main>',
  'sitemap.xml': '<urlset>\n  <url><loc>https://redcherryit.com/guides/stories/older-story</loc><lastmod>2026-09-01</lastmod></url>\n  <url><loc>https://redcherryit.com/pricing</loc></url>\n</urlset>',
};
const commits: { message: string; files: string[] }[] = [];
let pending: any;
const blobs: Buffer[] = [];
const github = http.createServer((req, res) => {
  let b = '';
  req.on('data', c => (b += c));
  req.on('end', () => {
    const send = (v: unknown, code = 200) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(v)); };
    const u = decodeURIComponent(req.url!.replace('/repos/me/site', '').split('?')[0]);
    if (req.headers.authorization !== 'Bearer fake') return send({ message: 'Bad credentials' }, 401);
    if (u === '/git/ref/heads/main') return send({ object: { sha: `head${commits.length}` } });
    if (u.startsWith('/contents/')) {
      const k = u.slice(10), f = repo[k], kids = Object.keys(repo).filter(p => p.startsWith(k + '/')).map(p => ({ name: p.slice(k.length + 1) }));
      const sha = f !== undefined && crypto.createHash('sha1').update(`blob ${Buffer.from(f).length}\0`).update(Buffer.from(f)).digest('hex');
      return f !== undefined ? send({ content: Buffer.from(f).toString('base64'), sha }) : kids.length ? send(kids) : send({}, 404);
    }
    if (u.startsWith('/git/commits/')) return send({ tree: { sha: 't' } });
    if (u === '/git/blobs') { blobs.push(Buffer.from(JSON.parse(b).content, 'base64')); return send({ sha: `blob${blobs.length - 1}` }); }
    if (u === '/git/trees') { pending = JSON.parse(b).tree; return send({ sha: 'nt' }); }
    if (u === '/git/commits') { const m = JSON.parse(b).message; pending.message = m; return send({ sha: `c${commits.length + 1}` }); }
    if (u === '/git/refs/heads/main') {
      for (const f of pending) repo[f.path] = f.content ?? blobs[+f.sha.slice(4)];
      commits.push({ message: pending.message, files: pending.map((f: any) => f.path) });
      return send({});
    }
    send({ message: 'unexpected ' + u }, 500);
  });
});

let app: any, closeBrowser: any;
before(async () => {
  for (const s of [claude, buffer, github]) await new Promise<void>(ok => s.listen(0, '127.0.0.1', () => ok()));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(claude.address() as any).port}`;
  process.env.BUFFER_API_URL = `http://127.0.0.1:${(buffer.address() as any).port}`;
  process.env.GITHUB_API_URL = `http://127.0.0.1:${(github.address() as any).port}`;
  ({ closeBrowser } = await import('../src/render.ts'));
  const { buildApp } = await import('../src/server.ts');
  (await import('../src/templates.ts')).seed();
  (await import('../src/copy.ts')).seed();
  app = buildApp();
});
after(async () => { await app.close(); await closeBrowser(); claude.close(); buffer.close(); github.close(); });

const headers = { 'x-api-key': 'test-key' };
const call = (method: string, url: string, payload?: unknown) => app.inject({ method, url, headers, payload });

test('a draft needs sources, and a good draft passes the checks', async () => {
  assert.equal((await call('POST', '/articles', { topic: 'Payments portal' })).statusCode, 400);
  const res = await call('POST', '/articles', { topic: 'Payments portal', keyword: 'information portal', sources });
  assert.equal(res.statusCode, 200, res.body);
  const a = res.json();
  assert.equal(a.status, 'draft');
  assert.equal(a.slug, 'building-an-information-portal-for-a-financial-services-business');
  assert.equal(a.url, 'https://redcherryit.com/guides/stories/building-an-information-portal-for-a-financial-services-business');
  assert.deepEqual(a.checks.errors, []);
  assert.deepEqual(a.checks.warnings, []);
});

test('checks catch dashes, missing headings, made up figures and [SOURCE NEEDED]', async () => {
  const body = exampleBody.replace('## FAQs', '## Questions').replace('three articles every week', 'five articles every week — 40% more')
    + '\n\nMost sites double their leads [SOURCE NEEDED]. See [a made up page](https://fake.example/x).';
  const a = (await call('PUT', '/articles/1', { body })).json();
  assert.equal(a.checks.errors.length, 3, JSON.stringify(a.checks));
  assert.match(a.checks.errors.join(' '), /"FAQs" heading/);
  assert.match(a.checks.errors.join(' '), /Dashes/);
  assert.match(a.checks.errors.join(' '), /SOURCE NEEDED/);
  assert.match(a.checks.warnings.join(' '), /40% does not appear/);
  assert.match(a.checks.warnings.join(' '), /fake\.example\/x is not in the sources/);
  const { inline } = await import('../src/markdown.ts');
  assert.equal(inline('[ICO](https://ico.org.uk/a) and [us](https://redcherryit.com/contact)'),
    '<a href="https://ico.org.uk/a" target="_blank" rel="noopener">ICO</a> and <a href="https://redcherryit.com/contact">us</a>');
  assert.equal((await call('POST', '/articles/1/approve')).statusCode, 422, 'cannot approve with errors');
  assert.equal((await call('PUT', '/articles/1', { body: exampleBody })).statusCode, 200);
});

test('approve, publish to the site repo, then queue one social post for approval', async () => {
  assert.equal((await call('POST', '/articles/1/publish')).statusCode, 409, 'not before approval');
  assert.equal((await call('POST', '/articles/1/approve')).statusCode, 200);
  assert.equal((await call('PUT', '/articles/1', { title: 'Changed' })).statusCode, 409, 'approved text is frozen');
  const pub = (await call('POST', '/articles/1/publish')).json();
  assert.equal(pub.status, 'published', JSON.stringify(pub));
  assert.equal(commits.length, 1);
  const page = `guides/stories/${pub.slug}.html`;
  const img = `images/guides/stories/${pub.slug}`;
  assert.deepEqual(commits[0].files.sort(), ['guides/index.html', 'guides/stories/index.html', page, 'sitemap.xml', `${img}.png`].sort());
  assert.match(repo['guides/index.html'], /<span class="guide-card-count">2 guides<\/span>/);
  assert.match(repo['guides/index.html'], /Coming soon/, 'other categories untouched');
  const html = repo[page];
  assert.match(html, /<title>Building an Information Portal for a Financial Services Business \| Red Cherry IT Guides<\/title>/);
  assert.match(html, /<strong>Short answer:<\/strong> A business in the financial sector/);
  assert.match(html, /<h2>The challenge<\/h2>/);
  assert.match(html, /<h3>Can a business publish its own articles without a developer\?<\/h3>/);
  assert.match(html, /"@type": "FAQPage"/);
  assert.doesNotMatch(html, /<img src="\/images\/guides/, 'the image is for link previews only, not shown on the page');
  assert.match(html, new RegExp(`<meta property="og:image" content="https://redcherryit.com/${img}.png">`));
  assert.match(html, /<meta property="og:image:alt" content="Building an Information Portal/);
  assert.match(html, /"@type": "ImageObject"/);
  assert.doesNotMatch(html, /\{\{\w+\}\}/, 'every slot is filled');
  assert.match(repo['guides/stories/index.html'], /href="older-story">\n        <\/a>\n        <a class="guide-card" href="building-an-information-portal/);
  assert.match(repo['sitemap.xml'], /older-story.*\n.*building-an-information-portal-for-a-financial-services-business<\/loc>.*\n.*pricing/);
  assert.equal((await call('POST', '/articles/1/publish')).statusCode, 200);
  assert.equal(commits.length, 1, 'publishing the same thing again changes nothing');

  const before = claudeCalls.length;
  const social = { template: 'social-post', channels: [{ id: 'li1', name: 'LinkedIn' }], mode: 'queue' };
  const s = (await call('POST', '/articles/1/social', social)).json();
  assert.equal(s.posts.length, 1);
  assert.equal(s.posts[0].status, 'pending_approval');
  assert.match(s.posts[0].text, /https:\/\/redcherryit\.com\/guides\/stories\/building/);
  assert.deepEqual(claudeCalls.slice(before), ['post', 'caption']);
  assert.equal(bufferSent.length, 0, 'nothing sent before approval');

  const again = (await call('POST', '/articles/1/social', social)).json();
  assert.equal(again.reused, true);
  assert.equal(again.posts[0].id, s.posts[0].id);
  assert.equal(claudeCalls.length, before + 2, 'Claude is not asked twice');
});

test('each category drafts with its own structure prompt', async () => {
  const cats = (await call('GET', '/articles/categories')).json();
  assert.ok(cats.some((c: any) => c.category === '/guides/learn/' && c.label === 'Learn'), JSON.stringify(cats));
  assert.equal((await call('POST', '/articles', { topic: 'x', sources, category: '/guides/tools/' })).statusCode, 400, 'no article-tools prompt yet');
  const res = await call('POST', '/articles', { topic: 'Portals explained', sources, category: '/guides/learn/' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(claudeCalls.at(-2), 'learn');
  assert.match(res.json().url, /\/guides\/learn\//);
  const a = (await call('PUT', `/articles/${res.json().id}`, { body: exampleBody.replace('## The challenge', '## Background') })).json();
  assert.deepEqual(a.checks.errors, [], 'learn articles do not need the story headings');
});

test('a page already on the site can be opened, edited and published again, keeping its own extras', async () => {
  // A live page that the tool did not make: built from the shell, with its own cards and banner heading.
  const { page } = await import('../src/articles.ts');
  repo['guides/learn/index.html'] = '<div class="guide-list">\n      </div>';
  repo['guides/learn/old-guide.html'] = page({ title: 'An old guide', summary: 'Old summary.', category: '/guides/learn/', slug: 'old-guide',
    body: '# An old guide\n\nThe short answer.\n\n## Steps\n\n1. First\n2. Second\n\nSee [pricing](https://redcherryit.com/pricing).\n\n## FAQs\n\n**Is it hard?**\nNo, it is easy.\n\n*No jargon. No stress.*' }, '2026-08-10')
    .replace('<h2>Ready To Get Started?</h2>', '<h2>Not Sure Where To Start?</h2>').replace('See More Of Our Client Success Stories', 'More Learn Guides');
  const list = (await call('GET', '/articles/in-category?category=/guides/learn/')).json();
  assert.ok(list.some((a: any) => a.slug === 'old-guide' && a.status === 'on_site'), JSON.stringify(list));
  const a = (await call('POST', '/articles/import', { category: '/guides/learn/', slug: 'old-guide' })).json();
  assert.equal(a.status, 'published');
  assert.equal(a.title, 'An old guide');
  assert.equal(a.summary, 'Old summary.');
  assert.match(a.body, /^# An old guide\n\nThe short answer\.\n\n## Steps\n\n1\. First\n2\. Second\n\nSee \[pricing\]\(https:\/\/redcherryit\.com\/pricing\)\.\n\n## FAQs\n\n\*\*Is it hard\?\*\*\nNo, it is easy\.\n\n\*No jargon\. No stress\.\*$/);
  assert.equal((await call('POST', '/articles/import', { category: '/guides/learn/', slug: 'old-guide' })).json().id, a.id, 'opening it again reuses it');
  assert.ok(!(await call('GET', '/articles/in-category?category=/guides/learn/')).json().some((x: any) => x.status === 'on_site'));

  await call('POST', `/articles/${a.id}/reopen`);
  const body = a.body.replace('The short answer.', 'The new short answer.').replace('## FAQs', 'Plain words here. '.repeat(200) + '\n\n## FAQs');
  assert.equal((await call('PUT', `/articles/${a.id}`, { body })).statusCode, 200);
  assert.equal((await call('POST', `/articles/${a.id}/approve`)).statusCode, 200);
  assert.equal((await call('POST', `/articles/${a.id}/publish`)).statusCode, 200);
  const html = repo['guides/learn/old-guide.html'];
  assert.match(html, /The new short answer/);
  assert.match(html, /<h2>Not Sure Where To Start\?<\/h2>/, 'banner heading kept');
  assert.match(html, /More Learn Guides/, 'related cards kept');
  assert.match(html, /<p>No jargon\. No stress\.<\/p>/);
  assert.match(html, /"datePublished": "2026-08-10"/);
});

test('the Social page can list every live guide and write a post from one, tagged with its category', async () => {
  const url = 'https://redcherryit.com/guides/stories/building-an-information-portal-for-a-financial-services-business';
  const live = (await call('GET', '/articles/live')).json();
  assert.ok(live.some((a: any) => a.url === url), JSON.stringify(live));
  // Read from the tool, not fetched, so it works before the site has deployed.
  const res = await call('POST', '/copy', { template: 'social-post', url });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().fields.tag, 'Stories');
  assert.equal(res.json().page.title, 'Building an Information Portal for a Financial Services Business');
});

test('research suggests ideas from a web search, skips pages already there, and counts searches in the spend', async () => {
  const { db } = await import('../src/db.ts');
  const res = await call('POST', '/articles/research', { category: '/guides/stories/', focus: 'build times' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().ideas[0].keyword, 'website build time');
  assert.equal(researchCalls.length, 2, 'resumed after the pause');
  const first = researchCalls[0];
  assert.equal(first.tools[0].type, 'web_search_20260209');
  assert.equal(first.output_config?.format, undefined, 'no structured output alongside search');
  const asked = JSON.stringify(first.messages);
  assert.match(asked, /\* Building an Information Portal/, 'lists what is already there');
  assert.match(asked, /build times/);
  assert.equal(researchCalls[1].messages.at(-1).role, 'assistant');
  const rows = db.prepare(`SELECT cost_usd FROM claude_usage WHERE job = 'article:research'`).all() as { cost_usd: number }[];
  const tokensOnly = (7000 * 2 + 900 * 10) / 1e6;
  assert.equal(rows.length, 2);
  assert.ok(Math.abs(rows.reduce((t, r) => t + r.cost_usd, 0) - tokensOnly - 0.03) < 1e-9, 'three searches at a cent each are counted');
  assert.equal((await call('POST', '/articles/research', { category: '/guides/nope/' })).statusCode, 400);
});

test('find sources keeps only facts with a link and writes them ready for the draft', async () => {
  const res = await call('POST', '/articles/sources', { category: '/guides/learn/', topic: 'How long does a website take to build?' });
  assert.equal(res.statusCode, 200, res.body);
  const r = res.json();
  assert.equal(r.facts.length, 1);
  assert.equal(r.text, '* Most brochure sites take four to six weeks. (Timelines, 2026: https://example.co.uk/timelines)');
  assert.equal(researchCalls.at(-1).tools[0].max_uses, 6);
});

test('a guide that is only on the site is read from the website repo, never fetched over the web', async () => {
  const { page } = await import('../src/articles.ts');
  repo['guides/stories/site-only.html'] = page({ title: 'A guide only on the site', summary: 'Site summary.', category: '/guides/stories/', slug: 'site-only',
    body: '# A guide only on the site\n\nThe short answer.\n\n## More\n\n' + 'Plain words about websites. '.repeat(20) }, '2026-08-10');
  const res = await call('POST', '/copy', { template: 'social-post', url: 'https://redcherryit.com/guides/stories/site-only' });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.json().page.title, /A guide only on the site/);
  assert.equal(res.json().fields.tag, 'Stories');
});
