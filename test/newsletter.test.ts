// The monthly newsletter against a fake Claude and a fake Resend, so nothing real is sent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { sendStream } from './sse.ts';

process.env.NODE_ENV = 'test';
process.env.API_KEY = 'test-key';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rct-newsletter-'));
process.env.ANTHROPIC_API_KEY = 'fake';
process.env.RESEND_API_KEY = 're_test';
process.env.PUBLIC_URL = 'https://studio.example';
process.env.SMTP_FROM = 'David Hanmer <david@redcherryit.com>';

let prompt = '';
const sent: any[] = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    if (req.url === '/emails') { sent.push(JSON.parse(body)); res.setHeader('content-type', 'application/json'); return res.end('{"id":"msg_1"}'); }
    prompt = body;
    sendStream(res, { id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: JSON.stringify({ subject: 'Three quick wins for your website this winter', preheader: 'Plus a tool that answers enquiries while you work.',
        body: 'Hi,\n\nHere is what is new.\n\n## New on the blog\n\n- [Why speed matters](https://redcherryit.com/guides/learn/speed): faster pages win more enquiries.\n\n## Quick tip\n\nCheck your opening hours on Google.\n\nThanks for reading,\n\nDavid' }) }],
      usage: { input_tokens: 2000, output_tokens: 600 } });
  });
});
let app: any;
const headers = { 'x-api-key': 'test-key' };
const call = (method: string, url: string, payload?: unknown) => app.inject({ method, url, headers, payload });
before(async () => {
  await new Promise<void>(ok => fake.listen(0, '127.0.0.1', () => ok()));
  const base = `http://127.0.0.1:${(fake.address() as any).port}`;
  process.env.ANTHROPIC_BASE_URL = base;
  process.env.RESEND_API_URL = base;
  app = (await import('../src/server.ts')).buildApp();
  (await import('../src/copy.ts')).seed();
  const { db } = await import('../src/db.ts');
  db.exec(`INSERT INTO articles (slug, category, title, summary, body, topic, keyword, sources, status, published_at)
    VALUES ('speed', '/guides/learn/', 'Why speed matters', 'Faster pages win more enquiries.', 'x', 'x', 'x', 'x', 'published', datetime('now', '-3 days'))`);
});
after(async () => { await app.close(); fake.close(); });

test('Claude drafts the newsletter from new guides and a client story, and nothing is sent', async () => {
  const { job } = (await call('POST', '/newsletters', { focus: 'missed calls' })).json();
  let n: any;
  for (;;) {
    const r = (await call('GET', `/jobs/${job}`)).json();
    if (r.done !== false) { if (r.error) throw new Error(r.error); n = r.result; break; }
    await new Promise(ok => setTimeout(ok, 20));
  }
  assert.equal(n.status, 'draft');
  assert.equal(n.subject, 'Three quick wins for your website this winter');
  assert.match(prompt, /Why speed matters: Faster pages win more enquiries\. \(https:\/\/redcherryit\.com\/guides\/learn\/speed\)/);
  assert.match(prompt, /missed calls/);
  assert.match(prompt, /A client story you may use:\\n[A-Z]/, 'one of the case studies');
  assert.equal(sent.length, 0);
});

test('the email has the preheader, the logo, styled links and a working unsubscribe link', async () => {
  const html = (await call('GET', '/newsletters/1/preview')).body;
  assert.match(html, /Plus a tool that answers enquiries while you work\./);
  assert.match(html, /src="https:\/\/studio\.example\/assets\/logo\.png"/);
  assert.match(html, /<a href="https:\/\/redcherryit\.com\/guides\/learn\/speed" style="color:#b5333f;font-weight:700">Why speed matters<\/a>/);
  assert.match(html, /<h2 style="[^"]+">New on the blog<\/h2>/);
  assert.match(html, /https:\/\/studio\.example\/unsubscribe\?e=preview%40example\.com&amp;t=/);
});

test('a test goes to David only, then the draft is edited and approved', async () => {
  assert.deepEqual((await call('POST', '/newsletters/1/test')).json(), { sent_to: 'david@redcherryit.com' });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ['david@redcherryit.com']);
  assert.equal(sent[0].subject, '[Test] Three quick wins for your website this winter');
  assert.match(sent[0].headers['List-Unsubscribe'], /^<https:\/\/studio\.example\/unsubscribe\?e=david%40redcherryit\.com&t=/);
  assert.match(sent[0].text, /Why speed matters \(https:\/\/redcherryit\.com\/guides\/learn\/speed\)/);

  assert.equal((await call('PUT', '/newsletters/1', { subject: 'Winter website wins' })).json().subject, 'Winter website wins');
  assert.equal((await call('POST', '/newsletters/1/approve')).json().status, 'approved');
  assert.equal((await call('PUT', '/newsletters/1', { subject: 'Again' })).statusCode, 409, 'an approved newsletter is not edited by accident');
  assert.equal((await call('POST', '/newsletters/1/approve')).statusCode, 409);
  assert.equal((await call('POST', '/newsletters/1/reopen')).json().status, 'draft');
});
