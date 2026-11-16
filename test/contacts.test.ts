// Newsletter contacts and website sign ups, against a fake Resend so nothing real is sent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.API_KEY = 'test-key';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rct-contacts-'));
process.env.RESEND_API_KEY = 're_test';
process.env.PUBLIC_URL = 'https://studio.example';

const sent: any[] = [], pushed: any[] = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    assert.equal(req.headers.authorization, 'Bearer re_test');
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/contacts/') || req.url === '/contacts' && req.method === 'POST') { // a confirmed sign up going into Resend
      pushed.push([req.method, decodeURIComponent(req.url), body && JSON.parse(body)]);
      res.statusCode = req.method === 'GET' ? 404 : 200;
      return res.end(req.method === 'GET' ? '{"message":"not found"}' : '{}');
    }
    if (req.url?.startsWith('/contacts')) { // two pages, as Resend pages them
      const after = new URL(req.url, 'http://x').searchParams.get('after');
      return res.end(JSON.stringify(after === 'c2'
        ? { object: 'list', has_more: false, data: [{ id: 'c3', email: 'gone@resend.example', first_name: '', last_name: '', unsubscribed: true }] }
        : { object: 'list', has_more: true, data: [{ id: 'c1', email: 'Kim@Resend.example', first_name: 'Kim', last_name: 'Ng', unsubscribed: false }, { id: 'c2', email: 'ann@shop.example', unsubscribed: false }] }));
    }
    assert.equal(req.url, '/emails');
    sent.push(JSON.parse(body));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: `msg_${sent.length}` }));
  });
});
let app: any;
const headers = { 'x-api-key': 'test-key' };
const call = (method: string, url: string, payload?: unknown) => app.inject({ method, url, headers, payload });
before(async () => {
  await new Promise<void>(ok => fake.listen(0, '127.0.0.1', () => ok()));
  process.env.RESEND_API_URL = `http://127.0.0.1:${(fake.address() as any).port}`;
  app = (await import('../src/server.ts')).buildApp();
});
after(async () => { await app.close(); fake.close(); });

test('pasted contacts go in once, with their tags, and bad addresses are reported', async () => {
  const r = (await call('POST', '/contacts', { text: 'Email,Name,Company\nann@shop.example,Ann Lee,Ann\'s Shop\nnot-an-email,Bob,Bob Ltd', tags: 'Client' })).json();
  assert.deepEqual(r, { added: 1, updated: 0, invalid: ['not-an-email'] });
  const again = (await call('POST', '/contacts', { text: 'ANN@shop.example, Ann', tags: 'enquiry' })).json();
  assert.deepEqual([again.added, again.updated], [0, 1], 'the same address in another case is the same contact');
  const list = (await call('GET', '/contacts')).json();
  assert.deepEqual(list.contacts.map((c: any) => [c.email, c.name, c.business, c.tags, c.status]), [['ann@shop.example', 'Ann Lee', "Ann's Shop", 'client, enquiry', 'subscribed']]);
  assert.deepEqual(list.tags, ['client', 'enquiry']);
  assert.equal((await call('GET', '/contacts?tag=client')).json().contacts.length, 1);
});

test('leads who replied can be added, cold leads never are', async () => {
  const { db } = await import('../src/db.ts');
  db.exec(`INSERT INTO leads (dedup_key, company_name, contact_name, email, source, status, has_website, lead_reason) VALUES
    ('a', 'Replied Ltd', 'Rita', 'rita@replied.example', 'places', 'replied', 1, 'x'), ('b', 'Cold Ltd', 'Colin', 'colin@cold.example', 'places', 'new', 1, 'x')`);
  const r = (await call('POST', '/contacts/import-replied')).json();
  assert.equal(r.added, 1);
  const emails = (await call('GET', '/contacts')).json().contacts.map((c: any) => c.email);
  assert.ok(emails.includes('rita@replied.example') && !emails.includes('colin@cold.example'));
});

test('a website sign up gets a confirm email and joins only when the button is pressed', async () => {
  const form = { 'content-type': 'application/x-www-form-urlencoded' };
  const res = await app.inject({ method: 'POST', url: '/subscribe', headers: form, payload: 'email=New%40Person.example&first_name=Nia&last_name=Bell+Jones&from=popup' });
  assert.equal(res.statusCode, 200, 'no API key needed');
  assert.match(res.body, /Check your inbox/);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ['new@person.example']);
  const link = sent[0].text.match(/https:\/\/studio\.example\/subscribe\/confirm\?\S+/)[0].replace('https://studio.example', '');
  assert.equal((await call('GET', '/contacts?status=pending')).json().contacts.length, 1, 'waits for the confirm');

  await app.inject({ method: 'POST', url: '/subscribe', headers: form, payload: 'email=new%40person.example' });
  assert.equal(sent.length, 1, 'a second sign up the same day sends nothing more');
  await app.inject({ method: 'POST', url: '/subscribe', headers: form, payload: 'email=bot%40spam.example&hp=x' });
  assert.equal(sent.length, 1, 'the hidden field catches bots');

  const open = await app.inject({ method: 'GET', url: link });
  assert.match(open.body, /Yes, sign me up/);
  assert.equal((await call('GET', '/contacts?status=pending')).json().contacts.length, 1, 'opening the link only asks');
  const yes = await app.inject({ method: 'POST', url: link });
  assert.match(yes.body, /You are on the list/);
  const c = (await call('GET', '/contacts')).json().contacts.find((x: any) => x.email === 'new@person.example');
  assert.deepEqual([c.status, c.source, c.tags, c.name], ['subscribed', 'signup', 'newsletter, popup', 'Nia Bell Jones']);
  assert.deepEqual(pushed.at(-1), ['POST', '/contacts', { email: 'new@person.example', first_name: 'Nia', last_name: 'Bell Jones', unsubscribed: false }], 'into Resend with first and last name');
  await app.inject({ method: 'POST', url: '/subscribe', headers: form, payload: 'email=phone%40person.example&website=https%3A%2F%2Fx.example' });
  assert.equal(sent.at(-1).to[0], 'phone@person.example', 'a phone that autofills a website field still signs up');

  const forged = await app.inject({ method: 'POST', url: '/subscribe/confirm?e=ann%40shop.example&t=wrongwrongwrongwrongwron' });
  assert.equal(forged.statusCode, 400);
});

test('an unsubscribed contact shows as unsubscribed, and confirming a new sign up lifts it', async () => {
  const outreach = await import('../src/outreach.ts');
  outreach.suppress(['ann@shop.example'], 'unsubscribed');
  const list = (await call('GET', '/contacts')).json();
  assert.equal(list.counts.unsubscribed, 1);
  assert.equal(list.contacts.find((c: any) => c.email === 'ann@shop.example').unsubscribed, 1);
  outreach.suppress(['bounce@person.example'], 'bounced');
  const contacts = await import('../src/contacts.ts');
  contacts.save([{ email: 'bounce@person.example' }]);
  const { db } = await import('../src/db.ts');
  const token = (e: string) => new URL((sent.at(-1)?.text.match(/https:\S+/) ?? ['https://x/?t='])[0]).searchParams.get('t');
  await app.inject({ method: 'POST', url: '/subscribe', headers: { 'content-type': 'application/json' }, payload: { email: 'ann@shop.example' } });
  const t = token('ann@shop.example')!;
  await app.inject({ method: 'POST', url: `/subscribe/confirm?e=ann%40shop.example&t=${t}` });
  assert.ok(!db.prepare('SELECT 1 FROM suppression WHERE email = ?').get('ann@shop.example'), 'they asked again, so the unsubscribe is lifted');
});

test('contacts added in Resend come across, and its unsubscribes go on the Do not email list', async () => {
  const r = (await call('POST', '/contacts/import-resend')).json();
  assert.deepEqual([r.found, r.added, r.unsubscribed], [3, 2, 1]);
  const list = (await call('GET', '/contacts')).json().contacts;
  const kim = list.find((c: any) => c.email === 'kim@resend.example');
  assert.deepEqual([kim.name, kim.tags, kim.source, kim.unsubscribed], ['Kim Ng', 'resend', 'resend', 0]);
  assert.equal(list.find((c: any) => c.email === 'gone@resend.example').unsubscribed, 1);
  assert.equal((await call('POST', '/contacts/import-resend')).json().added, 0, 'running it again adds nobody twice');
});

test('contacts can be edited and removed', async () => {
  const c = (await call('GET', '/contacts')).json().contacts[0];
  assert.equal((await call('PATCH', `/contacts/${c.id}`, { tags: 'VIP, client' })).json().tags, 'vip, client');
  assert.equal((await call('DELETE', `/contacts/${c.id}`)).statusCode, 200);
  assert.equal((await call('DELETE', `/contacts/${c.id}`)).statusCode, 404);
});
