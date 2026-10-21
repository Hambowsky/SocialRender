// Buffer posting against a fake Buffer GraphQL API on localhost, so nothing is ever posted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.API_KEY = 'test-key';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rct-buffer-'));
process.env.BUFFER_API_KEY = 'fake';
process.env.PUBLIC_URL = 'https://tool.example.com/';

const created: string[] = [];
let next: 'ok' | 'error' | 'down' = 'ok';
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    const { query } = JSON.parse(body);
    const send = (data: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data })); };
    if (query.includes('organizations')) return send({ account: { organizations: [{ id: 'org1', name: 'Red Cherry IT' }] } });
    if (query.includes('channels')) return send({ channels: [{ id: 'li1', name: 'rc', displayName: 'Red Cherry IT', service: 'linkedin' }, { id: 'fb1', name: 'rc', displayName: 'Red Cherry IT', service: 'facebook' }] });
    if (next === 'down') { res.statusCode = 502; return res.end('bad gateway'); }
    if (next === 'error') return send({ createPost: { message: 'Channel is disconnected' } });
    created.push(query);
    send({ createPost: { post: { id: `buf${created.length}` } } });
  });
});

let app: any, closeBrowser: any;
before(async () => {
  await new Promise<void>(ok => fake.listen(0, '127.0.0.1', () => ok()));
  process.env.BUFFER_API_URL = `http://127.0.0.1:${(fake.address() as any).port}`;
  ({ closeBrowser } = await import('../src/render.ts'));
  const { buildApp } = await import('../src/server.ts');
  (await import('../src/templates.ts')).seed();
  app = buildApp();
});
after(async () => { await app.close(); await closeBrowser(); fake.close(); });

const headers = { 'x-api-key': 'test-key' };
const fields = { headline: 'Why speed matters', highlight_word: 'speed', subtitle: 'Faster pages win enquiries.', tag: 'Guide', footer_left: 'Free guide', footer_right: 'redcherryit.com' };
let renderId = '';

test('channels come from every Buffer organisation', async () => {
  const res = await app.inject({ method: 'GET', url: '/buffer/channels', headers });
  assert.deepEqual(res.json(), [{ id: 'li1', name: 'Red Cherry IT', service: 'linkedin', organization: 'Red Cherry IT' },
    { id: 'fb1', name: 'Red Cherry IT', service: 'facebook', organization: 'Red Cherry IT' }]);
});

test('a post waits for approval, then goes to Buffer exactly once with a public image', async () => {
  const r = await app.inject({ method: 'POST', url: '/render?format=json', headers, payload: { template: 'social-post', fields } });
  renderId = r.json().id;
  const post = { render_id: renderId, channels: [{ id: 'li1', name: 'LinkedIn' }], text: 'Slow pages cost you enquiries.', mode: 'queue' };
  const [p] = (await app.inject({ method: 'POST', url: '/posts', headers, payload: post })).json();
  assert.equal(p.status, 'pending_approval');
  assert.equal(created.length, 0, 'nothing sent before approval');

  const again = (await app.inject({ method: 'POST', url: '/posts', headers, payload: post })).json();
  assert.equal(again[0].id, p.id, 'the same post twice is one post');

  const img = await app.inject({ method: 'GET', url: `/public/renders/${renderId}.png` });
  assert.equal(img.statusCode, 200, 'Buffer can fetch the image without a key');

  const [a, b] = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: `/posts/${p.id}/approve`, headers })));
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409], 'two approvals send once');
  assert.equal(created.length, 1);
  assert.match(created[0], new RegExp(`url: "https://tool.example.com/public/renders/${renderId}.png"`));
  assert.match(created[0], /mode: addToQueue/);
  const sent = (await app.inject({ method: 'GET', url: '/posts?status=sent', headers })).json();
  assert.equal(sent[0].buffer_post_id, 'buf1');
});

test('a Buffer error fails cleanly, an unclear one asks David to check', async () => {
  const mk = async (text: string) => (await app.inject({ method: 'POST', url: '/posts', headers,
    payload: { render_id: renderId, channels: [{ id: 'li1' }], text, mode: 'draft' } })).json()[0];
  next = 'error';
  const failed = (await app.inject({ method: 'POST', url: `/posts/${(await mk('one')).id}/approve`, headers })).json();
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /disconnected/);

  next = 'down';
  const unsure = (await app.inject({ method: 'POST', url: `/posts/${(await mk('two')).id}/approve`, headers })).json();
  assert.equal(unsure.status, 'check_buffer');
  const marked = (await app.inject({ method: 'POST', url: `/posts/${unsure.id}/mark-sent`, headers })).json();
  assert.equal(marked.status, 'sent');
  next = 'ok';
});

test('a scheduled post needs a future time, and the API needs a key', async () => {
  const res = await app.inject({ method: 'POST', url: '/posts', headers,
    payload: { render_id: renderId, channels: [{ id: 'li1' }], text: 'x', mode: 'scheduled', due_at: '2020-01-01T09:00:00Z' } });
  assert.equal(res.statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/posts' })).statusCode, 401);
});

test('a Facebook post tells Buffer it is a post, and other networks send no metadata', async () => {
  const post = { render_id: renderId, channels: [{ id: 'fb1', name: 'Facebook' }], text: 'Facebook needs a post type.', mode: 'queue' };
  const [p] = (await app.inject({ method: 'POST', url: '/posts', headers, payload: post })).json();
  const sent = (await app.inject({ method: 'POST', url: `/posts/${p.id}/approve`, headers })).json();
  assert.equal(sent.status, 'sent', JSON.stringify(sent));
  assert.match(created.at(-1)!, /metadata: \{ facebook: \{ type: post \} \}/);
  assert.ok(!created.some(q => q.includes('li1') && q.includes('metadata')));
});
