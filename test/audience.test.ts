// Resend segments and topics on the Email page, against a fake Resend that keeps state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.API_KEY = 'test-key';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rct-audience-'));
process.env.RESEND_API_KEY = 're_test';

const segments = [{ id: 's1', name: 'Clients' }];
const topics: any[] = [{ id: 't1', name: 'Monthly newsletter', default_subscription: 'opt_in' }];
const people: Record<string, { segs: Set<string>; topics: Record<string, string> }> = { 'kim@shop.example': { segs: new Set(['s1']), topics: {} } };
const calls: string[] = [];
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    const u = new URL(req.url!, 'http://x'), p = u.pathname.split('/').map(decodeURIComponent), body = raw ? JSON.parse(raw) : {};
    calls.push(`${req.method} ${decodeURIComponent(u.pathname)}`);
    const send = (code: number, b: unknown) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(b)); };
    const list = (data: unknown[]) => send(200, { object: 'list', has_more: false, data });
    const who = people[p[2]];
    if (u.pathname === '/segments') return req.method === 'POST' ? (segments.push({ id: `s${segments.length + 1}`, name: body.name }), send(200, segments.at(-1))) : list(segments);
    if (u.pathname === '/topics') return req.method === 'POST' ? (topics.push({ id: `t${topics.length + 1}`, ...body }), send(200, topics.at(-1))) : list(topics);
    if (u.pathname === '/contacts' && req.method === 'POST') { people[body.email] = { segs: new Set(), topics: {} }; return send(200, { id: 'new' }); }
    if (u.pathname === '/contacts') return list(Object.entries(people).filter(([, v]) => v.segs.has(u.searchParams.get('segment_id')!)).map(([email]) => ({ id: email, email })));
    if (!who) return send(404, { message: 'Contact not found' });
    if (p[3] === 'segments' && p[4]) { req.method === 'POST' ? who.segs.add(p[4]) : who.segs.delete(p[4]); return send(200, {}); }
    if (p[3] === 'segments') return list([...who.segs].map(id => segments.find(s => s.id === id)));
    if (p[3] === 'topics' && req.method === 'PATCH') { for (const t of body.topics) who.topics[t.id] = t.subscription; return send(200, {}); }
    if (p[3] === 'topics') return list(Object.entries(who.topics).map(([id, subscription]) => ({ id, subscription })));
    send(500, { message: 'unexpected' });
  });
});
let app: any;
const call = (method: string, url: string, payload?: unknown) => app.inject({ method, url, headers: { 'x-api-key': 'test-key' }, payload });
before(async () => {
  await new Promise<void>(ok => fake.listen(0, '127.0.0.1', () => ok()));
  process.env.RESEND_API_URL = `http://127.0.0.1:${(fake.address() as any).port}`;
  app = (await import('../src/server.ts')).buildApp();
  await call('POST', '/contacts', { text: 'kim@shop.example, Kim Ng\nnew@shop.example, Nia Bell' });
});
after(async () => { await app.close(); fake.close(); });

test('segments and topics come from Resend, with who is in each segment', async () => {
  assert.equal((await call('POST', '/contacts/segments', { name: 'Local' })).statusCode, 200);
  assert.equal((await call('POST', '/contacts/topics', { name: 'Offers', default_subscription: 'opt_out' })).statusCode, 200);
  const a = (await call('GET', '/contacts/audience')).json();
  assert.deepEqual(a.segments.map((s: any) => s.name), ['Clients', 'Local']);
  assert.deepEqual(a.topics.map((t: any) => [t.name, t.default_subscription]), [['Monthly newsletter', 'opt_in'], ['Offers', 'opt_out']]);
  assert.deepEqual(a.members, { 'kim@shop.example': ['s1'] });
});

test('a contact is moved between segments and their topic choices are saved', async () => {
  const kim = (await call('GET', '/contacts')).json().contacts.find((c: any) => c.email === 'kim@shop.example');
  const r = (await call('PUT', `/contacts/${kim.id}/resend`, { segments: ['s2'], topics: [{ id: 't2', subscription: 'opt_in' }] })).json();
  assert.deepEqual(r, { inResend: true, segments: ['s2'], topics: [{ id: 't2', subscription: 'opt_in' }] });
  assert.ok(calls.includes('DELETE /contacts/kim@shop.example/segments/s1'));
});

test('someone not in Resend is added first, but only once they are subscribed', async () => {
  const nia = (await call('GET', '/contacts')).json().contacts.find((c: any) => c.email === 'new@shop.example');
  assert.deepEqual((await call('GET', `/contacts/${nia.id}/resend`)).json(), { inResend: false, segments: [], topics: [] });
  assert.equal((await call('PUT', `/contacts/${nia.id}/resend`, { segments: ['s1'], topics: [] })).json().inResend, true);
  const { db } = await import('../src/db.ts');
  db.prepare("INSERT INTO contacts (email, status, source) VALUES ('wait@shop.example', 'pending', 'signup')").run();
  const wait = (await call('GET', '/contacts')).json().contacts.find((c: any) => c.email === 'wait@shop.example');
  assert.equal((await call('PUT', `/contacts/${wait.id}/resend`, { segments: ['s1'], topics: [] })).statusCode, 409);
});
