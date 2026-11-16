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
process.env.RESEND_WEBHOOK_SECRET = `whsec_${Buffer.from('webhook-test-secret').toString('base64')}`;
process.env.PUBLIC_URL = 'https://studio.example';
process.env.SMTP_FROM = 'David Hanmer <david@redcherryit.com>';

let prompt = '';
const sent: any[] = [], broadcasts: any[] = [], patched: string[] = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const json = (b: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(b)); };
    const list = (data: unknown[]) => json({ object: 'list', has_more: false, data });
    if (req.url === '/emails') { sent.push(JSON.parse(body)); return json({ id: 'msg_1' }); }
    if (req.url?.startsWith('/segments')) return list([{ id: 'seg_all', name: 'Everyone' }, { id: 'seg_cl', name: 'Clients' }]);
    if (req.url?.startsWith('/topics')) return list([{ id: 'top_news', name: 'Monthly newsletter', default_subscription: 'opt_in' }]);
    if (req.url?.startsWith('/contacts?')) return list(req.url.includes('seg_all') ? [{ id: 'a', email: 'ok@x.example' }, { id: 'b', email: 'gone@x.example' }] : []);
    if (req.method === 'PATCH') { patched.push(decodeURIComponent(req.url!)); return json({}); }
    if (req.url === '/broadcasts') { broadcasts.push(JSON.parse(body)); return json({ id: 'bc_1' }); }
    prompt = body;
    sendStream(res, { id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: JSON.stringify({ subject: 'Three quick wins for your website this winter', preheader: 'Plus a tool that answers enquiries while you work.',
        body: 'Hi,\n\nHere is what is new.\n\n## New on the blog\n\n- [Why speed matters](https://redcherryit.com/guides/learn/speed): faster pages win more enquiries.\n\n## Quick tip\n\nCheck your opening hours on Google.\n\nThanks for reading,\n\nDavid',
        segment: 'everyone', topic: 'Monthly newsletter', why: 'It is for everyone who knows us.' }) }],
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
  assert.match(prompt, /Segments:\\nEveryone\\nClients/);
  assert.deepEqual([n.kind, n.segment_id, n.topic_id, n.pick_note], ['monthly', 'seg_all', 'top_news', 'It is for everyone who knows us.'], 'names map to Resend ids');
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

test('sending hands it to Resend once, to the segment and topic, with Do not email people unsubscribed first', async () => {
  const { db } = await import('../src/db.ts');
  db.exec(`INSERT INTO suppression (email, reason) VALUES ('gone@x.example', 'unsubscribed')`);
  assert.equal((await call('POST', '/newsletters/1/send')).statusCode, 409, 'a draft is never sent');
  await call('POST', '/newsletters/1/approve');
  const n = (await call('POST', '/newsletters/1/send')).json();
  assert.equal(n.status, 'sent');
  assert.deepEqual(patched, ['/contacts/gone@x.example']);
  assert.equal(broadcasts.length, 1);
  assert.deepEqual([broadcasts[0].segment_id, broadcasts[0].topic_id, broadcasts[0].send], ['seg_all', 'top_news', true]);
  assert.match(broadcasts[0].html, /\{\{\{RESEND_UNSUBSCRIBE_URL\}\}\}/);
  assert.doesNotMatch(broadcasts[0].html, /studio\.example\/unsubscribe/);
  assert.equal((await call('POST', '/newsletters/1/send')).statusCode, 409, 'never twice');
  assert.equal(broadcasts.length, 1);
});

test('a one off email needs a brief and uses its own prompt', async () => {
  assert.equal((await call('POST', '/newsletters', { kind: 'oneoff', focus: ' ' })).statusCode, 400);
  const { job } = (await call('POST', '/newsletters', { kind: 'oneoff', focus: 'closed over Christmas' })).json();
  let r: any;
  do { r = (await call('GET', `/jobs/${job}`)).json(); await new Promise(ok => setTimeout(ok, 20)); } while (r.done === false);
  assert.equal(r.result.kind, 'oneoff');
  assert.match(prompt, /one off email/);
  assert.match(prompt, /closed over Christmas/);
});

test('Resend webhooks are checked, counted once, and bounces and complaints go on the Do not email list', async () => {
  const crypto = await import('node:crypto');
  const secret = Buffer.from('webhook-test-secret').toString('base64');
  const post = (id: string, event: unknown, sign = true) => {
    const body = JSON.stringify(event), ts = String(Math.floor(Date.now() / 1000));
    const sig = crypto.createHmac('sha256', Buffer.from(secret, 'base64')).update(`${id}.${ts}.${body}`).digest('base64');
    return app.inject({ method: 'POST', url: '/resend/webhook', headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sign ? sig : 'bad'}` }, payload: body });
  };
  const ev = (type: string, to: string, extra = {}) => ({ type, data: { broadcast_id: 'bc_1', to: [to], ...extra } });
  assert.equal((await post('m0', ev('email.opened', 'ok@x.example'), false)).statusCode, 401, 'unsigned posts are refused');
  for (const [id, e] of [['m1', ev('email.delivered', 'ok@x.example')], ['m2', ev('email.delivered', 'b@x.example')], ['m3', ev('email.opened', 'ok@x.example')],
    ['m3', ev('email.opened', 'ok@x.example')], ['m4', ev('email.opened', 'ok@x.example')], ['m5', ev('email.clicked', 'ok@x.example', { click: { link: 'https://redcherryit.com/seo' } })],
    ['m6', ev('email.bounced', 'b@x.example', { bounce: { type: 'Permanent' } })], ['m7', ev('email.complained', 'c@x.example')],
    ['m8', { type: 'contact.updated', data: { email: 'U@x.example', unsubscribed: true } }]] as const)
    assert.equal((await post(id, e)).statusCode, 200);
  const n = (await call('GET', '/newsletters/1')).json();
  assert.deepEqual([n.stats.delivered, n.stats.opened, n.stats.clicked, n.stats.bounced, n.stats.complained], [2, 1, 1, 1, 1], 'each person counted once');
  assert.deepEqual(n.stats.links, [{ link: 'https://redcherryit.com/seo', n: 1 }]);
  const { db } = await import('../src/db.ts');
  assert.deepEqual(db.prepare(`SELECT email, reason FROM suppression WHERE email IN ('b@x.example', 'c@x.example', 'u@x.example') ORDER BY email`).all().map((r: any) => [r.email, r.reason]),
    [['b@x.example', 'bounced'], ['c@x.example', 'complained'], ['u@x.example', 'unsubscribed']]);
  assert.equal((await call('GET', '/dashboard/marketing')).json().emails[0].stats.opened, 1);
});
