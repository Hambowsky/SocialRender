// Articles against a fake Claude and a fake Buffer, so tests cost nothing and post nothing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

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
const serve = (handler: (body: any) => unknown) => http.createServer((req, res) => {
  let b = '';
  req.on('data', c => (b += c));
  req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(handler(JSON.parse(b)))); });
});
const claude = serve(r => {
  const prompt = JSON.stringify(r.messages);
  claudeCalls.push(prompt.includes('Red Cherry IT article') ? 'article' : prompt.includes('Write the caption') ? 'caption' : 'post');
  const out = prompt.includes('Red Cherry IT article')
    ? { title: 'Building an Information Portal for a Financial Services Business', summary: 'How we built a portal that publishes three articles a week.', body: exampleBody }
    : prompt.includes('Write the caption')
    ? { caption: 'How a payments business publishes three articles a week without a developer.', hashtags: ['#WebDesign', '#SEO', '#ContentMarketing'] }
    : { headline: 'Three articles a week', highlight_word: 'Three', subtitle: 'A portal the team runs themselves.', tag: 'Case Study', footer_left: 'Read the story' };
  return { id: 'msg', type: 'message', role: 'assistant', model: r.model, stop_reason: 'end_turn', stop_sequence: null, stop_details: null,
    content: [{ type: 'text', text: JSON.stringify(out) }], usage: { input_tokens: 3000, output_tokens: 1500 } };
});
const bufferSent: string[] = [];
const buffer = serve(({ query }) => (bufferSent.push(query), { data: { createPost: { post: { id: 'b1' } } } }));

// A fake GitHub holding a tiny copy of the website repo.
const repo: Record<string, string> = {
  'guides/stories/index.html': '<main>\n      <div class="guide-list">\n        <a class="guide-card" href="older-story">\n        </a>\n      </div>\n</main>',
  'sitemap.xml': '<urlset>\n  <url><loc>https://redcherryit.com/guides/stories/older-story</loc><lastmod>2026-09-01</lastmod></url>\n  <url><loc>https://redcherryit.com/pricing</loc></url>\n</urlset>',
};
const commits: { message: string; files: string[] }[] = [];
let pending: any;
const github = http.createServer((req, res) => {
  let b = '';
  req.on('data', c => (b += c));
  req.on('end', () => {
    const send = (v: unknown, code = 200) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(v)); };
    const u = decodeURIComponent(req.url!.replace('/repos/me/site', '').split('?')[0]);
    if (req.headers.authorization !== 'Bearer fake') return send({ message: 'Bad credentials' }, 401);
    if (u === '/git/ref/heads/main') return send({ object: { sha: `head${commits.length}` } });
    if (u.startsWith('/contents/')) { const f = repo[u.slice(10)]; return f === undefined ? send({}, 404) : send({ content: Buffer.from(f).toString('base64') }); }
    if (u.startsWith('/git/commits/')) return send({ tree: { sha: 't' } });
    if (u === '/git/trees') { pending = JSON.parse(b).tree; return send({ sha: 'nt' }); }
    if (u === '/git/commits') { const m = JSON.parse(b).message; pending.message = m; return send({ sha: `c${commits.length + 1}` }); }
    if (u === '/git/refs/heads/main') {
      for (const f of pending) repo[f.path] = f.content;
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
    + '\n\nMost sites double their leads [SOURCE NEEDED].';
  const a = (await call('PUT', '/articles/1', { body })).json();
  assert.equal(a.checks.errors.length, 3, JSON.stringify(a.checks));
  assert.match(a.checks.errors.join(' '), /"FAQs" heading/);
  assert.match(a.checks.errors.join(' '), /Dashes/);
  assert.match(a.checks.errors.join(' '), /SOURCE NEEDED/);
  assert.match(a.checks.warnings.join(' '), /40% does not appear/);
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
  assert.deepEqual(commits[0].files.sort(), ['guides/stories/index.html', page, 'sitemap.xml'].sort());
  const html = repo[page];
  assert.match(html, /<title>Building an Information Portal for a Financial Services Business \| Red Cherry IT Guides<\/title>/);
  assert.match(html, /<strong>Short answer:<\/strong> A business in the financial sector/);
  assert.match(html, /<h2>The challenge<\/h2>/);
  assert.match(html, /<h3>Can a business publish its own articles without a developer\?<\/h3>/);
  assert.match(html, /"@type": "FAQPage"/);
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
