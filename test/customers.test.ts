// Customers against a fake mail server and a fake Google, so nothing real is ever sent.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.NODE_ENV = 'test';
process.env.API_KEY = 'test-key';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rct-customers-'));
process.env.SMTP_FROM = 'David Hanmer <david@redcherryit.com>';
process.env.GSC_CREDENTIALS = JSON.stringify({ client_email: 'studio@rct.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });

const google: string[] = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    google.push(req.url!);
    if (req.url === '/token') return res.end(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
    if (req.url!.startsWith('/psi')) return res.end(JSON.stringify({ lighthouseResult: { categories: { performance: { score: 0.81 }, seo: { score: 0.92 } }, audits: {} } }));
    const b = JSON.parse(body || '{}');
    if (req.url === '/ga/properties/123456:runReport') {
      const now = b.dateRanges[0].endDate === '2026-11-18';
      if (!b.dimensions) return res.end(JSON.stringify({ rows: [{ metricValues: [{ value: now ? '300' : '200' }, { value: '400' }, { value: '900' }] }] }));
      return res.end(JSON.stringify({ rows: [{ dimensionValues: [{ value: b.dimensions[0].name === 'pagePath' ? '/' : 'Organic Search' }], metricValues: [{ value: '1' }, { value: '250' }, { value: '600' }] }] }));
    }
    if (req.url === '/gsc/sites/sc-domain%3Apipepros.co.uk/searchAnalytics/query') {
      const rows = b.dimensions.length ? [{ keys: ['plumber sheffield'], clicks: 12, impressions: 300, ctr: 0.04, position: 6.24 }]
        : [{ keys: [], clicks: b.endDate === '2026-11-18' ? 40 : 20, impressions: 1000, ctr: 0.04, position: 9.81 }];
      return res.end(JSON.stringify({ rows }));
    }
    res.statusCode = 404; res.end('{}');
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
const call = async (method: string, url: string, payload?: object) => app.inject({ method, url, headers, payload });
before(async () => {
  await new Promise<void>(ok => fake.listen(0, '127.0.0.1', () => ok()));
  await new Promise<void>(ok => smtp.listen(0, '127.0.0.1', () => ok()));
  const base = `http://127.0.0.1:${(fake.address() as any).port}`;
  Object.assign(process.env, { GSC_TOKEN_URL: `${base}/token`, GSC_API_URL: `${base}/gsc`, GA4_API_URL: `${base}/ga`, PAGESPEED_URL: `${base}/psi`,
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String((smtp.address() as any).port) });
  app = (await import('../src/server.ts')).buildApp();
  db = (await import('../src/db.ts')).db;
});
after(async () => { await app.close(); fake.close(); smtp.close(); await (await import('../src/render.ts')).closeBrowser(); });

const job = async (res: any) => {
  assert.equal(res.statusCode, 202, res.body);
  for (;;) {
    const r = await call('GET', `/jobs/${res.json().job}`);
    if (r.statusCode !== 200 || r.json().done) return r;
    await new Promise(ok => setTimeout(ok, 50));
  }
};

let id: number;
test('a won lead becomes a customer once, and the lead is marked converted', async () => {
  const lead = Number(db.prepare(`INSERT INTO leads (dedup_key, company_name, email, phone, website_url, address, postcode, contact_name, town, industry, source, has_website, lead_reason)
    VALUES ('pp', 'Pipe Pros', 'sam@pipepros.co.uk', '0114 496 0000', 'https://www.pipepros.co.uk', '1 High Street', 'S1 1AA', 'Sam De Pipe', 'Sheffield', 'plumbers', 'places', 1, 'old site')`).run().lastInsertRowid);
  const c = (await call('POST', `/leads/${lead}/customer`)).json();
  assert.deepEqual([c.business_name, c.first_name, c.last_name, c.address, c.email], ['Pipe Pros', 'Sam', 'De Pipe', '1 High Street, S1 1AA', 'sam@pipepros.co.uk']);
  assert.equal((await call('POST', `/leads/${lead}/customer`)).json().id, c.id);
  assert.equal(db.prepare('SELECT status FROM leads WHERE id = ?').get(lead).status, 'converted');
  id = c.id;
});

test('details, services and notes save', async () => {
  const c = (await call('PUT', `/customers/${id}`, { services: ['Web design', 'SEO'], ga4_property: '123456', phone: '07700 900000' })).json();
  assert.deepEqual(c.services, ['Web design', 'SEO']);
  assert.equal(c.service_email, 'studio@rct.iam.gserviceaccount.com');
  assert.equal((await call('PUT', `/customers/${id}`, { business_name: ' ' })).statusCode, 400);
  const n = (await call('POST', `/customers/${id}/notes`, { text: 'Rebuilt the contact page' })).json();
  assert.equal(n.activity[0].text, 'Rebuilt the contact page');
  const list = (await call('GET', '/customers')).json();
  assert.equal(list.customers[0].contact_name, 'Sam De Pipe');
  assert.ok(list.services.includes('Website care plan'));
});

test('an email goes from David\'s mailbox with no unsubscribe line, and is logged', async () => {
  const before = mail.length;
  const c = (await call('POST', `/customers/${id}/email`, { subject: 'Your new pages', body: 'Hi Sam,\n\nThey are live.' })).json();
  assert.equal(mail.length, before + 1);
  assert.match(mail.at(-1)!, /Subject: Your new pages/);
  assert.doesNotMatch(mail.at(-1)!, /unsubscribe/i);
  assert.equal(c.activity[0].kind, 'email');
});

test('invoices number on from the start, send once with a PDF, and a sent one cannot be deleted', async () => {
  assert.equal((await call('PUT', '/invoice-settings', { from: 'David Hanmer\nRed Cherry IT', payment: 'Sort code 00-00-00', start: 100 })).json().prefix, 'RC-');
  const items = [{ description: 'Website care plan, December', qty: 1, price: 49 }, { description: 'Extra page', qty: 2, price: 75.5 }];
  const preview = await call('POST', `/customers/${id}/invoices/preview`, { items });
  assert.equal(preview.headers['content-type'], 'application/pdf');
  assert.equal(preview.rawPayload.subarray(0, 4).toString(), '%PDF');
  const inv = (await call('POST', `/customers/${id}/invoices`, { items, note: 'Thank you' })).json();
  assert.deepEqual([inv.total, inv.label, inv.status], [200, 'Draft', 'draft']);
  const before = mail.length;
  const sent = (await call('POST', `/invoices/${inv.id}/send`, { message: 'Hi Sam, invoice attached.' })).json();
  assert.deepEqual([sent.label, sent.status, sent.overdue], ['RC-0100', 'sent', false]);
  assert.equal(mail.length, before + 1);
  assert.match(mail.at(-1)!, /filename=invoice-RC-0100\.pdf/);
  assert.equal((await call('POST', `/invoices/${inv.id}/send`, { message: 'again' })).statusCode, 409);
  assert.equal(mail.length, before + 1);
  assert.equal((await call('DELETE', `/invoices/${inv.id}`)).statusCode, 409);
  const two = (await call('POST', `/customers/${id}/invoices`, { items: [{ description: 'Hosting', qty: 1, price: 10 }] })).json();
  assert.equal((await call('POST', `/invoices/${two.id}/send`, { message: 'x' })).json().label, 'RC-0101');
  assert.equal((await call('GET', '/customers')).json().customers[0].unpaid, 210);
  assert.equal((await call('POST', `/invoices/${inv.id}/paid`, { paid: true })).json().status, 'paid');
  assert.equal((await call('GET', '/customers')).json().customers[0].unpaid, 10);
  const draft = (await call('POST', `/customers/${id}/invoices`, { items })).json();
  assert.equal((await call('DELETE', `/invoices/${draft.id}`)).statusCode, 200);
  assert.equal((await call('DELETE', `/customers/${id}`)).statusCode, 409);
});

test('a mail server refusal puts the invoice back to draft with its number', async () => {
  const c = (await call('POST', '/customers', { business_name: 'Bouncy Ltd', email: 'reject@bouncy.example' })).json();
  const inv = (await call('POST', `/customers/${c.id}/invoices`, { items: [{ description: 'Logo', qty: 1, price: 100 }] })).json();
  assert.equal((await call('POST', `/invoices/${inv.id}/send`, { message: 'x' })).statusCode, 502);
  const after = (await call('GET', `/customers/${c.id}`)).json().invoices[0];
  assert.deepEqual([after.status, after.label], ['draft', 'RC-0102']);
  assert.match(after.error, /mail server/);
});

test('analytics: Google Analytics visitors and Search Console for their domain, kept for the day', async () => {
  const { analytics } = await import('../src/customers.ts');
  google.length = 0;
  const a = await analytics(id, new Date('2026-11-21T12:00:00Z'));
  assert.deepEqual([a.from, a.to], ['2026-10-22', '2026-11-18']);
  assert.deepEqual([a.visitors.users, a.visitors.before.users, a.visitors.channels[0].name, a.visitors.pages[0].path], [300, 200, 'Organic Search', '/']);
  assert.deepEqual([a.search.site, a.search.clicks, a.search.before.clicks, a.search.position, a.search.queries[0].query], ['sc-domain:pipepros.co.uk', 40, 20, 9.8, 'plumber sheffield']);
  assert.equal(a.speed.scores.seo, 92);
  const calls = google.length;
  await analytics(id, new Date('2026-11-21T15:00:00Z'));
  assert.equal(google.length, calls);
});

test('the client report sends as a PDF with this month\'s notes', async () => {
  assert.deepEqual((await call('GET', `/customers/${id}/report/notes`)).json().notes, ['Rebuilt the contact page']);
  const { reportHtml, analytics } = await import('../src/customers.ts');
  const html = reportHtml(id, await analytics(id, new Date('2026-11-21T12:00:00Z')), 'Rebuilt the contact page');
  assert.match(html, /How <em>Pipe Pros<\/em> did online/);
  assert.match(html, /up 50% on the 28 days before/);
  const before = mail.length;
  const r = await job(await call('POST', `/customers/${id}/report/send`, { work: 'Rebuilt the contact page', subject: 'Your November report', body: 'Hi Sam' }));
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(mail.length, before + 1);
  assert.match(mail.at(-1)!, /filename=report-\d{4}-\d{2}\.pdf/);
});
