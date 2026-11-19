// Homepage concepts in outreach emails, against a fake Claude and a fake mail server.
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
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rct-concept-'));
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
      const out = body.includes('free homepage concept for a local business')
        ? { headline: 'Leaks fixed fast in Sheffield', highlight: 'fast', intro: 'Same day plumbing repairs from a local team.', cta: 'Get a free quote',
          trust: ['Free quotes', 'Local to Sheffield', 'Fast replies'], services: [{ title: 'Leak repairs', text: 'Drips and bursts sorted.' }, { title: 'Boilers', text: 'Servicing and repairs.' }, { title: 'Bathrooms', text: 'Fitted and finished.' }],
          about_title: 'A local team', about: 'We look after homes across Sheffield.', closing: 'Need a plumber today?', nav: ['Services', 'About', 'Reviews', 'Contact'] }
        : { subject: 'A new homepage idea for you', body: 'Hello,\n\nWe made a quick idea of your homepage.\n[concept]\nWould you like us to build it?\n\nDavid Hanmer\nRed Cherry IT' };
      return sendStream(res, { id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: JSON.stringify(out) }],
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
after(async () => { await app.close(); fake.close(); smtp.close(); await (await import('../src/render.ts')).closeBrowser(); });

const call = (method: string, url: string, payload?: unknown) => app.inject({ method, url, headers, payload });
async function job(method: string, url: string, payload?: unknown) {
  const { job } = (await call(method, url, payload)).json();
  for (;;) {
    const r = await call('GET', `/jobs/${job}`);
    if (r.json().done !== false) return r.json();
    await new Promise(ok => setTimeout(ok, 50));
  }
}

test('a campaign set to show a concept makes one, puts it inside the first email and sends it as a picture', async () => {
  const c = (await call('POST', '/campaigns', { name: 'Plumbers', industries: 'Plumbers', towns: 'Sheffield', lead_type: 'no_website', max_leads: 10, sources: ['places'], concept: true })).json();
  assert.equal(c.concept, 1);
  const id = Number(db.prepare(`INSERT INTO leads (dedup_key, company_name, email, phone, town, industry, source, has_website, lead_reason, campaign_id, rating, reviews)
    VALUES ('k', 'Pipe Pros', 'hi@pipes.example', '0114 496 0000', 'Sheffield', 'Plumbers', 'places', 0, 'No website', ?, 4.8, 52)`).run(c.id).lastInsertRowid);
  const e = (await job('POST', `/leads/${id}/email`)).result;
  assert.equal(e.concept, 1);
  assert.equal(claudeCalls, 2, 'one call for the concept, one for the email');
  assert.match(lastPrompt, /Homepage concept shown in this email: yes/);
  const shot = await call('GET', `/leads/${id}/concept/showcase.jpg`);
  assert.equal(shot.statusCode, 200);
  assert.ok(shot.rawPayload.length > 20_000, 'a real picture');
  const lead = (await call('GET', `/leads/${id}`)).json();
  assert.equal(lead.concept.brand.phone, '0114 496 0000', 'the phone number from the lead');

  // David changes a word: redrawn without Claude.
  const edited = (await job('PUT', `/leads/${id}/concept`, { headline: 'Plumbing done properly' })).result;
  assert.equal(edited.copy.headline, 'Plumbing done properly');
  assert.equal(claudeCalls, 2);

  await call('POST', `/emails/${e.id}/approve`);
  for (let i = 0; i < 200 && mail.length === 0; i++) await new Promise(ok => setTimeout(ok, 20));
  const m = mail.pop()!;
  assert.match(m, /src=(3D)?"cid:concept"/);
  assert.match(m, /Content-ID: <concept>/i);
  assert.match(m, /Content-Type: image\/jpeg/i);
  assert.doesNotMatch(m.split(/Content-Type: text\/html/i)[0], /\[concept\]/, 'the marker never shows in the plain text part');
});

test('the brand is read from a page: logo, the main colour, big photos and the phone number', async () => {
  const { extract } = await import('../src/concept.ts');
  const { chromium } = await import('playwright');
  const b = await chromium.launch();
  const page = await b.newPage();
  const pic = (w: number, h: number) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"/>`)}`;
  await page.setContent(`<header style="background:#fff"><img class="site-logo" src="${pic(180, 50)}"><a href="tel:01144960000">0114 496 0000</a></header>
    <section style="background:#c0392b;height:400px"><button style="background:#c0392b;color:#fff">Quote</button></section>
    <img src="${pic(1200, 800)}" style="width:900px"><img src="${pic(100, 100)}">`);
  const d = await page.evaluate(extract);
  await b.close();
  assert.equal(d.colours[0], '#c0392b');
  assert.ok(d.logo && 'src' in d.logo && d.logo.src.startsWith('data:'));
  assert.equal(d.logo_on_dark, false);
  assert.equal(d.photos.length, 1, 'only the big picture, not the logo or the icon');
  assert.equal(d.phone, '0114 496 0000');
});
