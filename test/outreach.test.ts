// Outreach against a fake Claude and a fake mail server, so nothing real is ever sent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { sendStream } from './sse.ts';

process.env.NODE_ENV = 'test';
process.env.API_KEY = 'test-key';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rct-outreach-'));
process.env.ANTHROPIC_API_KEY = 'fake';
process.env.SMTP_FROM = 'David Hanmer <david@redcherryit.com>';
process.env.PUBLIC_URL = 'https://studio.example';
process.env.OUTREACH_DELAY_SECONDS = '0';
process.env.OUTREACH_DAILY_CAP = '2';

let claudeCalls = 0, lastPrompt = '';
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    lastPrompt = body;
    if (req.url === '/v1/messages') {
      claudeCalls++;
      return sendStream(res, { id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: JSON.stringify({ subject: 'A free website concept for you', body: 'Hello,\n\nYour reviews are great.\n\nDavid Hanmer\nRed Cherry IT' }) }],
        usage: { input_tokens: 2000, output_tokens: 200 } });
    }
    res.statusCode = 404;
    res.end();
  });
});

// Just enough SMTP for nodemailer: anything to a "reject" address is refused, everything else is kept.
const mail: string[] = [];
const smtp = net.createServer(sock => {
  let data: string | null = null;
  sock.write('220 fake ESMTP\r\n');
  sock.on('data', chunk => {
    if (data !== null) {
      data += chunk;
      if (data.endsWith('\r\n.\r\n')) { mail.push(data); data = null; sock.write('250 queued\r\n'); }
      return;
    }
    for (const line of String(chunk).split('\r\n').filter(Boolean)) {
      if (/^RCPT/i.test(line) && line.includes('reject')) sock.write('550 no such user\r\n');
      else if (/^DATA/i.test(line)) { data = ''; sock.write('354 go on\r\n'); }
      else if (/^QUIT/i.test(line)) { sock.end('221 bye\r\n'); }
      else sock.write('250 ok\r\n');
    }
  });
});

let app: any, db: any;
const headers = { 'x-api-key': 'test-key' };
before(async () => {
  await new Promise<void>(ok => fake.listen(0, '127.0.0.1', () => ok()));
  await new Promise<void>(ok => smtp.listen(0, '127.0.0.1', () => ok()));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(fake.address() as any).port}`;
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String((smtp.address() as any).port);
  app = (await import('../src/server.ts')).buildApp();
  (await import('../src/copy.ts')).seed();
  db = (await import('../src/db.ts')).db;
});
after(async () => { await app.close(); fake.close(); smtp.close(); });

const addLead = (name: string, email: string) => Number(db.prepare(`INSERT INTO leads (dedup_key, company_name, email, town, industry, source, has_website, lead_reason)
  VALUES (?, ?, ?, 'Sheffield', 'Plumbers', 'places', 0, 'No website')`).run(name, name, email).lastInsertRowid);

async function draft(id: number) {
  const { job } = (await app.inject({ method: 'POST', url: `/leads/${id}/email`, headers })).json();
  for (;;) {
    const r = await app.inject({ method: 'GET', url: `/jobs/${job}`, headers });
    if (r.json().done !== false) return r;
    await new Promise(ok => setTimeout(ok, 20));
  }
}
const email = (id: number) => db.prepare('SELECT * FROM emails WHERE id = ?').get(id);
async function settle(id: number) {
  for (let i = 0; i < 200 && ['approved', 'sending'].includes(email(id).status); i++) await new Promise(ok => setTimeout(ok, 20));
  return email(id);
}

test('the mail settings can be tested before any lead is drafted', async () => {
  const r = await app.inject({ method: 'POST', url: '/emails/check', headers });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { sent_to: 'david@redcherryit.com', inbox: 'not set up (IMAP_HOST is blank)' });
  assert.match(mail.pop()!, /Subject: \[Test\] Your studio can send email/);
});

test('a lead with an email address gets a draft, and asking twice gives the same one', async () => {
  const smith = addLead('Smith Plumbing', 'Office@Smith.example');
  const first = (await draft(smith)).json().result;
  assert.equal(first.status, 'pending_approval');
  assert.equal(first.to_email, 'office@smith.example');
  assert.equal((await draft(smith)).json().result.id, first.id);
  assert.equal(claudeCalls, 1);
  assert.match(lastPrompt, /Elliott Spoors Roofing and Solar Panels \(Roofers\)/, 'case studies are in the prompt');
});

test('case studies can be added one at a time or many at once, updated by name and removed', async () => {
  const save = (rows: object[]) => app.inject({ method: 'POST', url: '/case-studies', headers, payload: { rows } });
  assert.equal((await save([{ client: 'Smith Plumbing', industry: 'Plumbers', blurb: 'We built a site.' }])).statusCode, 200);
  assert.equal((await save([{ client: 'smith plumbing', industry: 'Plumbers', blurb: 'We built a better site.' },
    { client: 'Jones Electrics', industry: 'Electricians', blurb: 'We built a site.' }])).json().saved, 2);
  assert.equal((await save([{ client: ' ', industry: 'x', blurb: 'y' }])).statusCode, 400);
  const list = (await app.inject({ method: 'GET', url: '/case-studies', headers })).json();
  const smith = list.filter((c: any) => /smith/i.test(c.client));
  assert.deepEqual(smith.map((c: any) => c.blurb), ['We built a better site.']);
  assert.equal((await app.inject({ method: 'DELETE', url: `/case-studies/${smith[0].id}`, headers })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/case-studies', headers })).json().length, list.length - 1);
});

test('an approved email goes out once with an unsubscribe link, and the lead is marked contacted', async () => {
  const { id } = db.prepare(`SELECT id FROM emails WHERE to_email = 'office@smith.example'`).get();
  assert.equal((await app.inject({ method: 'PUT', url: `/emails/${id}`, headers, payload: { subject: 'A website concept for Smith Plumbing' } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/emails/${id}/approve`, headers })).statusCode, 200);
  const sent = await settle(id);
  assert.equal(sent.status, 'sent');
  assert.equal(mail.length, 1);
  assert.match(mail[0], /Subject: A website concept for Smith Plumbing/);
  assert.match(mail[0], /List-Unsubscribe:\s+<https:\/\/studio\.example\/unsubscribe\?e=office%40smith\.example&t=/);
  assert.match(mail[0].replace(/=\r\n/g, ''), /unsubscribe here: https:\/\/studio\.example\/unsubscribe\?e=3Doffice%40smith/);
  assert.equal((await app.inject({ method: 'POST', url: `/emails/${id}/approve`, headers })).statusCode, 409, 'a sent email cannot go again');
  const lead = db.prepare('SELECT status FROM leads WHERE id = ?').get(sent.lead_id);
  assert.equal(lead.status, 'contacted');
  const again = await draft(sent.lead_id);
  assert.equal(again.statusCode, 409);
  assert.match(again.json().error, /already emailed/);
});

test('a refused address fails cleanly, and the daily cap holds the rest until tomorrow', async () => {
  const ids = [];
  for (const [name, to] of [['Reject Heating', 'reject@heat.example'], ['Jones Electrics', 'hi@jones.example'], ['Brown Builders', 'hi@brown.example']]) {
    const r = (await draft(addLead(name, to))).json().result;
    ids.push(r.id);
    await app.inject({ method: 'POST', url: `/emails/${r.id}/approve`, headers });
    await settle(r.id);
  }
  const [refused, second, third] = ids.map(email);
  assert.equal(refused.status, 'failed');
  assert.match(refused.error, /550/);
  assert.equal(second.status, 'sent');
  assert.equal(third.status, 'approved', 'the cap of 2 a day is used up');
  const list = (await app.inject({ method: 'GET', url: '/emails', headers })).json();
  assert.deepEqual([list.sent_today, list.daily_cap], [2, 2]);
});

test('unsubscribing needs a valid link and a click, and stops every email to that address', async () => {
  const { unsubscribeUrl } = await import('../src/outreach.ts');
  const url = unsubscribeUrl('hi@brown.example').replace('https://studio.example', '');
  const bad = url.replace(/t=[^&]+/, 't=forged');
  assert.equal((await app.inject({ method: 'GET', url: bad })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: bad })).statusCode, 400);
  const page = await app.inject({ method: 'GET', url });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /<button/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM suppression').get().n, 0, 'opening the link does nothing on its own');
  // A mail app's one click unsubscribe posts the form body RFC 8058 sets out.
  const done = await app.inject({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'List-Unsubscribe=One-Click' });
  assert.equal(done.statusCode, 200);
  assert.equal(db.prepare(`SELECT reason FROM suppression WHERE email = 'hi@brown.example'`).get().reason, 'unsubscribed');
  const waiting = db.prepare(`SELECT status FROM emails WHERE to_email = 'hi@brown.example'`).get();
  assert.equal(waiting.status, 'rejected', 'the approved email waiting for tomorrow is dropped');
  const lead = db.prepare(`SELECT id, status FROM leads WHERE email = 'hi@brown.example'`).get();
  assert.equal(lead.status, 'not_interested');
  assert.equal((await draft(lead.id)).statusCode, 409);

  // Addresses pasted in by hand, such as the old tool's list.
  const added = await app.inject({ method: 'POST', url: '/suppression', headers, payload: { emails: ['A@one.example', 'not an email', 'a@one.example', 'b@two.example'] } });
  assert.equal(added.json().added, 2);
  assert.equal((await app.inject({ method: 'GET', url: '/suppression', headers })).json().length, 3);
});

test('the inbox check marks replies and hard bounces, and ignores out of office and delay notices', async () => {
  const { handleMessage } = await import('../src/inbox.ts');
  const smith = db.prepare(`SELECT id, lead_id, message_id FROM emails WHERE to_email = 'office@smith.example'`).get();
  const status = (id: number) => db.prepare('SELECT status FROM leads WHERE id = ?').get(id).status;
  const msg = (headers: string, body = 'Hi') => `${headers.trim().split('\n').map(l => l.trim()).join('\r\n')}\r\n\r\n${body}`;

  assert.equal(handleMessage(msg(`From: Office <office@smith.example>
    Subject: Automatic reply: A website concept for Smith Plumbing
    Auto-Submitted: auto-replied
    In-Reply-To: ${smith.message_id}`)), 'ignored');
  assert.equal(status(smith.lead_id), 'contacted');
  assert.equal(handleMessage(msg(`From: Sam Smith <office@smith.example>
    Subject: Re: A website concept for Smith Plumbing
    In-Reply-To:
     ${smith.message_id}`, 'Yes please')), 'reply');
  assert.equal(status(smith.lead_id), 'replied');

  const jones = db.prepare(`SELECT id, lead_id, message_id FROM emails WHERE to_email = 'hi@jones.example'`).get();
  const report = (code: string) => msg(`From: Mail Delivery System <MAILER-DAEMON@mx.example>
    Subject: Undelivered Mail Returned to Sender
    Content-Type: multipart/report; report-type=delivery-status; boundary="b"`,
    `--b\r\nContent-Type: message/delivery-status\r\n\r\nFinal-Recipient: rfc822; hi@jones.example\r\nAction: ${code.startsWith('5') ? 'failed' : 'delayed'}\r\nStatus: ${code}\r\n\r\n--b\r\nContent-Type: text/rfc822-headers\r\n\r\nMessage-ID: ${jones.message_id}\r\n--b--`);
  assert.equal(handleMessage(report('4.4.7')), 'ignored');
  assert.equal(handleMessage(report('5.1.1')), 'bounce');
  assert.equal(db.prepare('SELECT status FROM emails WHERE id = ?').get(jones.id).status, 'bounced');
  assert.equal(status(jones.lead_id), 'bounced');
  assert.equal(db.prepare(`SELECT reason FROM suppression WHERE email = 'hi@jones.example'`).get().reason, 'bounced');
  assert.equal(handleMessage(msg('From: someone@else.example\nSubject: Hello')), 'ignored', 'mail that is not about outreach is left alone');
});

test('a whole campaign can be drafted at once, skipping leads already emailed, and every draft approved together', async () => {
  const camp = Number(db.prepare(`INSERT INTO campaigns (name, lead_type, industries, towns, max_leads, sources) VALUES ('Leeds roofers', 'no_website', 'Roofers', 'Leeds', 50, 'places')`).run().lastInsertRowid);
  const add = (name: string, email: string) => db.prepare(`UPDATE leads SET campaign_id = ? WHERE id = ?`).run(camp, addLead(name, email));
  add('Roof One', 'one@roof.example'); add('Roof Two', 'two@roof.example'); add('Roof None', ''); add('Roof Smith', 'office@smith.example');
  assert.equal((await app.inject({ method: 'GET', url: `/campaigns/${camp}`, headers })).json().to_draft, 3);
  const { job } = (await app.inject({ method: 'POST', url: `/campaigns/${camp}/email`, headers })).json();
  let r;
  do { await new Promise(ok => setTimeout(ok, 20)); r = (await app.inject({ method: 'GET', url: `/jobs/${job}`, headers })).json(); } while (r.done === false);
  assert.deepEqual(r.result, { drafted: 2, skipped: 0 }, 'the lead with no address and the address already emailed are left out');
  const waiting = db.prepare(`SELECT COUNT(*) AS n FROM emails WHERE status = 'pending_approval'`).get().n;
  assert.equal((await app.inject({ method: 'POST', url: '/emails/approve-all', headers })).json().approved, waiting);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM emails WHERE status = 'pending_approval'`).get().n, 0);
});
