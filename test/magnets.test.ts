// Free guides: drafted by a fake Claude, published to a local folder, and sent by a fake Resend once someone confirms.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { sendStream } from './sse.ts';

process.env.NODE_ENV = 'test';
process.env.API_KEY = 'test-key';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rct-magnets-'));
process.env.ANTHROPIC_API_KEY = 'fake';
process.env.RESEND_API_KEY = 're_test';
process.env.PUBLIC_URL = 'https://studio.example';
delete process.env.SITE_REPO;

const words = Array.from({ length: 1600 }, (_, i) => `word${i % 50}`).join(' ');
const guide = { title: 'The website checklist for UK plumbers', summary: 'Ten fixes that win more calls.', headline: 'Win more calls from your website',
  pitch: 'Most plumbers lose enquiries to slow pages. This shows what to fix first.', bullets: ['What to fix first', 'A ten point checklist'],
  body: `Plumbers lose calls to slow sites.\n\n## Speed\n\n${words}\n\n## Checklist\n\n- [ ] Test your site on a phone\n\n## Sources\n\n- [Ofcom](https://ofcom.example/report)`,
  sources: [{ title: 'Ofcom report', url: 'https://ofcom.example/report', facts: 'Most people browse on phones' }, { title: 'No link', url: 'not a url', facts: 'x' }] };
let prompt = '';
const sent: any[] = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/emails') { sent.push(JSON.parse(body)); return res.end('{"id":"msg"}'); }
    if (req.url?.startsWith('/contacts')) { res.statusCode = req.method === 'GET' ? 404 : 200; return res.end('{}'); }
    prompt = body;
    sendStream(res, { id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: JSON.stringify(guide) }], usage: { input_tokens: 4000, output_tokens: 4000 } });
  });
});
let app: any;
const headers = { 'x-api-key': 'test-key' };
const call = (method: string, url: string, payload?: unknown) => app.inject({ method, url, headers, payload });
const form = { 'content-type': 'application/x-www-form-urlencoded' };
before(async () => {
  await new Promise<void>(ok => fake.listen(0, '127.0.0.1', () => ok()));
  const base = `http://127.0.0.1:${(fake.address() as any).port}`;
  process.env.ANTHROPIC_BASE_URL = base;
  process.env.RESEND_API_URL = base;
  app = (await import('../src/server.ts')).buildApp();
  (await import('../src/copy.ts')).seed();
});
after(async () => { await app.close(); fake.close(); await (await import('../src/render.ts')).closeBrowser(); });

test('a guide is researched and written, then approved and published with its PDF and landing page', async () => {
  const { job } = (await call('POST', '/guides', { topic: 'website basics', audience: 'plumbers' })).json();
  let r: any;
  do { r = (await call('GET', `/jobs/${job}`)).json(); await new Promise(ok => setTimeout(ok, 20)); } while (r.done === false);
  const g = r.result;
  assert.match(prompt, /website basics/);
  assert.match(prompt, /plumbers/);
  assert.equal(g.slug, 'the-website-checklist-for-uk-plumbers');
  assert.equal(g.sources, '* Most people browse on phones (Ofcom report: https://ofcom.example/report)', 'only sources with a web link are kept');
  assert.deepEqual(g.checks.errors, []);
  assert.equal((await call('POST', `/guides/${g.id}/publish`)).statusCode, 409, 'a draft is never published');
  assert.equal((await call('PUT', `/guides/${g.id}`, { headline: 'Get more calls from your website' })).json().headline, 'Get more calls from your website');
  await call('POST', `/guides/${g.id}/approve`);
  assert.equal((await call('PUT', `/guides/${g.id}`, { title: 'x' })).statusCode, 409, 'what was approved is what goes live');
  const p = (await call('POST', `/guides/${g.id}/publish`)).json();
  assert.equal(p.status, 'published');
  const html = fs.readFileSync(path.join(process.env.DATA_DIR!, 'site', 'guides', 'free', `${g.slug}.html`), 'utf8');
  assert.match(html, /action="https:\/\/studio\.example\/subscribe"/);
  assert.match(html, /name="guide" value="the-website-checklist-for-uk-plumbers"/);
  assert.match(html, /<h1>Get more calls from your website<\/h1>/);
  assert.doesNotMatch(html, /\{\{\w+\}\}/, 'every slot is filled');
  const pdf = await app.inject({ method: 'GET', url: `/free-guides/${g.slug}.pdf` });
  assert.equal(pdf.statusCode, 200, 'the PDF link works without the API key');
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.equal((await app.inject({ method: 'GET', url: '/free-guides/nothing.pdf' })).statusCode, 404);
});

test('signing up on the landing page sends the guide once they confirm, or straight away if already on the list', async () => {
  const slug = 'the-website-checklist-for-uk-plumbers';
  await app.inject({ method: 'POST', url: '/subscribe', headers: form, payload: `email=pat%40pipes.example&first_name=Pat&from=guide&guide=${slug}` });
  assert.match(sent.at(-1).subject, /Please confirm to get The website checklist for UK plumbers/);
  const c = (await call('GET', '/contacts')).json().contacts.find((x: any) => x.email === 'pat@pipes.example');
  assert.equal(c.tags, `newsletter, guide, guide-${slug}`);
  const link = sent.at(-1).text.match(/https:\/\/studio\.example(\/subscribe\/confirm\?\S+)/)[1];
  const yes = await app.inject({ method: 'POST', url: link });
  assert.match(yes.body, /Download The website checklist for UK plumbers/);
  assert.equal(sent.at(-1).subject, 'Your free guide: The website checklist for UK plumbers');
  assert.match(sent.at(-1).text, new RegExp(`https://studio.example/free-guides/${slug}.pdf`));
  assert.equal((await call('GET', '/guides')).json()[0].signups.confirmed, 1);

  await call('POST', '/contacts', { text: 'kim@known.example, Kim' });
  const before = sent.length;
  await app.inject({ method: 'POST', url: '/subscribe', headers: form, payload: `email=kim%40known.example&from=guide&guide=${slug}` });
  assert.deepEqual(sent.slice(before).map(m => m.subject), ['Your free guide: The website checklist for UK plumbers'], 'no confirm needed, just the guide');
});

test('a campaign can offer a published guide in its outreach emails', async () => {
  const c = (await call('POST', '/campaigns', { name: 'Plumbers', industries: 'Plumbers', towns: 'Leeds', lead_type: 'both', max_leads: 10, sources: ['places'], guide_id: 1 })).json();
  assert.equal(c.guide_id, 1);
  const { offer } = await import('../src/magnets.ts');
  assert.equal(offer(c.id), 'The website checklist for UK plumbers: https://redcherryit.com/guides/free/the-website-checklist-for-uk-plumbers');
  assert.equal(offer(null), 'none');
});
