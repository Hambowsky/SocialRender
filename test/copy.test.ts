// Copywriting against a fake Claude API on localhost, so tests cost nothing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.API_KEY = 'test-key';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rct-copy-'));
process.env.ANTHROPIC_API_KEY = 'fake';
process.env.CLAUDE_MONTHLY_CAP_GBP = '1';
process.env.OPENAI_API_KEY = 'fake';

const calls: any[] = [], openai: any[] = [];
let claudeDown = false;
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    const r = JSON.parse(body);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/chat/completions') {
      openai.push(r);
      return res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"caption": "From OpenAI", "hashtags": ["#SEO"]}' } }], usage: { prompt_tokens: 1000, completion_tokens: 200 } }));
    }
    if (claudeDown) { res.statusCode = 529; return res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })); }
    calls.push(r);
    const prompt = JSON.stringify(r.messages);
    const design = prompt.includes('Design a new 1080');
    const good = fs.readFileSync(path.join(import.meta.dirname, '..', 'templates', 'tip-card.html'), 'utf8').replace('<title>Tip card', '<title>Event card');
    const snow = fs.readFileSync(path.join(import.meta.dirname, '..', 'templates', 'social-post.html'), 'utf8')
      .replace('<div class="rule">', '<div data-decor aria-hidden="true" style="position:absolute;inset:0;pointer-events:none;background:radial-gradient(#fff 3px,transparent 4px) 0 0/60px 60px"></div>\n    <div class="rule">');
    const out = prompt.includes('for one post only') ? { html: snow }
      : design
      ? (r.messages.length === 1 ? { name: 'event-card', html: good.replace('</style>', '</style><link href="https://fonts.googleapis.com/x">') } : { name: 'event-card', html: good })
      : prompt.includes('Write the caption')
      ? { caption: 'Slow pages cost you enquiries. Get in touch for a fixed price quote.', hashtags: ['#WebDesign', '#SmallBusiness', '#SEO'] }
      : r.messages.length === 1 // first draft is too long, the rewrite fits
        ? { headline: 'Why speed matters so much more than you think for every small business website in the UK today', highlight_word: 'speed', subtitle: 'Faster pages keep visitors.', tag: 'Marketing Guide', footer_left: 'Free guide' }
        : { headline: 'Why speed matters', highlight_word: 'speed', subtitle: 'Faster pages keep visitors and win more enquiries.', tag: 'Marketing Guide', footer_left: 'Free guide' };
    res.end(JSON.stringify({
      id: 'msg_fake', type: 'message', role: 'assistant', model: r.model, stop_reason: 'end_turn', stop_sequence: null, stop_details: null,
      content: [{ type: 'text', text: JSON.stringify(out) }],
      usage: { input_tokens: 2000, output_tokens: 300 },
    }));
  });
});

let app: any, closeBrowser: any, db: any;
before(async () => {
  await new Promise<void>(ok => fake.listen(0, '127.0.0.1', () => ok()));
  process.env.ANTHROPIC_BASE_URL = process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(fake.address() as any).port}`;
  ({ closeBrowser } = await import('../src/render.ts'));
  ({ db } = await import('../src/db.ts'));
  const { buildApp } = await import('../src/server.ts');
  (await import('../src/templates.ts')).seed();
  (await import('../src/copy.ts')).seed();
  app = buildApp();
});
after(async () => { await app.close(); await closeBrowser(); fake.close(); });

const headers = { 'x-api-key': 'test-key' };

test('copy writes fields, rewrites once when they do not fit, then writes a caption', async () => {
  const res = await app.inject({ method: 'POST', url: '/copy', headers, payload: { template: 'social-post', topic: 'Website speed' } });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.fits, true, res.body);
  assert.equal(body.fields.headline, 'Why speed matters');
  assert.equal(body.fields.footer_right, 'redcherryit.com');
  assert.ok(body.caption && body.hashtags.length === 3);
  assert.deepEqual(calls.map(c => c.model), ['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  assert.match(JSON.stringify(calls[1].messages.at(-1)), /does not fit/);
  assert.match(calls[0].system, /Red Cherry IT/);
  const rows = db.prepare('SELECT job FROM claude_usage ORDER BY id').all().map((r: any) => r.job);
  assert.deepEqual(rows, ['copy:social-post', 'copy:social-post:retry', 'copy:caption']);
});

test('a test run uses unsaved prompt text and saves nothing', async () => {
  const before = calls.length;
  const res = await app.inject({ method: 'POST', url: '/prompts/caption/test', headers,
    payload: { vars: { headline: 'Why speed matters', subtitle: 'x' }, body: '---\nmodel: claude-haiku-5-5\n---\nWrite the caption for {headline}' } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(calls.length, before + 1);
  assert.match(JSON.stringify(calls.at(-1).messages), /Write the caption for Why speed matters/);
});

test('when Claude is overloaded the job goes to OpenAI and counts towards the same cap', async () => {
  claudeDown = true;
  try {
    const res = await app.inject({ method: 'POST', url: '/prompts/caption/test', headers,
      payload: { vars: { headline: 'Why speed matters', subtitle: 'x' }, body: '---\nmodel: claude-haiku-5-5\n---\nWrite the caption for {headline}' } });
    assert.equal(res.statusCode, 200, res.body);
    assert.match(res.body, /From OpenAI/);
    assert.equal(openai.length, 1);
    assert.match(openai[0].messages[0].content, /JSON schema/);
    assert.match(openai[0].messages[1].content, /Write the caption for Why speed matters/);
    const row = db.prepare(`SELECT model, cost_usd FROM claude_usage ORDER BY id DESC LIMIT 1`).get();
    assert.equal(row.model, 'gpt-5');
    assert.ok(row.cost_usd > 0);
  } finally { claudeDown = false; }
});

test('calls stop once the monthly cap would be passed', async () => {
  db.prepare(`INSERT INTO claude_usage (job, model, input_tokens, output_tokens, cost_usd) VALUES ('test', 'claude-sonnet-5-5', 0, 0, 5)`).run();
  const before = calls.length;
  const res = await app.inject({ method: 'POST', url: '/copy', headers, payload: { template: 'social-post', topic: 'Website speed' } });
  assert.equal(res.statusCode, 402, res.body);
  assert.equal(calls.length, before, 'no request reached Claude');
});

test('prompts are versioned and can be rolled back', async () => {
  const first = (await app.inject({ method: 'GET', url: '/prompts/caption', headers })).json();
  assert.ok(first.vars.includes('headline'));
  const saved = await app.inject({ method: 'PUT', url: '/prompts/caption', headers, payload: { body: first.body + '\nKeep it upbeat.', note: 'test' } });
  assert.equal(saved.statusCode, 200, saved.body);
  await app.inject({ method: 'POST', url: `/prompts/caption/rollback/${first.version}`, headers });
  assert.equal((await app.inject({ method: 'GET', url: '/prompts/caption', headers })).json().body, first.body);
  const bad = await app.inject({ method: 'PUT', url: '/prompts/caption', headers, payload: { body: '---\neffort: huge\n---\nx' } });
  assert.equal(bad.statusCode, 400);
});

test('Claude designs a template, gets one fix up round, and nothing is saved until asked', async () => {
  db.prepare('DELETE FROM claude_usage').run(); // clear the cap test's spend
  const res = await app.inject({ method: 'POST', url: '/templates/design', headers, payload: { description: 'An event card', base: 'social-post' } });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.ok, true, res.body);
  assert.equal(body.name, 'event-card');
  assert.match(JSON.stringify(calls.at(-1).messages.at(-1)), /loads something from outside the app/);
  assert.equal((await app.inject({ method: 'GET', url: '/templates/event-card', headers })).statusCode, 404);
  const saved = await app.inject({ method: 'PUT', url: '/templates/event-card', headers, payload: { html: body.html, note: 'Designed with Claude' } });
  assert.equal(saved.statusCode, 200, saved.body);
});

test('a page link is turned into plain text, and private addresses are refused', async () => {
  const { guideTag } = await import('../src/copy.ts');
  assert.equal(guideTag('https://redcherryit.com/guides/learn/how-much-does-a-website-cost-uk'), 'Learn');
  assert.equal(guideTag('https://example.com/guides/learn/x'), undefined);
  assert.equal(guideTag('https://redcherryit.com/pricing'), undefined);
  const { pageText } = await import('../src/page.ts');
  const p = pageText(`<html><head><title>Speed &amp; SEO</title><meta name="description" content="Why it matters"></head>
    <body><nav>Menu</nav><script>evil()</script><h1>Fast sites</h1><p>Pages that load in 2&nbsp;seconds keep visitors.</p><footer>Copyright</footer></body></html>`);
  assert.equal(p.title, 'Speed & SEO');
  assert.equal(p.description, 'Why it matters');
  assert.equal(p.text, 'Fast sites\nPages that load in 2 seconds keep visitors.');
  for (const url of ['http://127.0.0.1:3000/usage', 'http://[::1]/', 'http://169.254.169.254/latest', 'file:///etc/passwd']) {
    const res = await app.inject({ method: 'POST', url: '/copy', headers, payload: { template: 'social-post', url } });
    assert.equal(res.statusCode, 400, url);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/copy', headers, payload: { template: 'social-post' } })).statusCode, 400);
});

test('a one off change makes a changed copy for one post and leaves the saved template alone', async () => {
  const { sampleOf, current } = await import('../src/templates.ts');
  const before = current('social-post').body;
  const fields = sampleOf(before);
  const res = await app.inject({ method: 'POST', url: '/templates/tweak', headers, payload: { template: 'social-post', change: 'Add snow', fields } });
  assert.equal(res.statusCode, 200, res.body);
  const t = res.json();
  assert.equal(t.ok, true, res.body);
  assert.match(t.html, /data-decor/, 'snow covering other blocks passes the layout check');
  assert.equal(current('social-post').body, before, 'saved template unchanged');
  const plain = await app.inject({ method: 'POST', url: '/render?format=json', headers, payload: { template: 'social-post', fields } });
  const snowy = await app.inject({ method: 'POST', url: '/render?format=json', headers, payload: { template: 'social-post', fields, html: t.html } });
  assert.equal(snowy.statusCode, 200, snowy.body);
  assert.notEqual(snowy.json().id, plain.json().id);
});
