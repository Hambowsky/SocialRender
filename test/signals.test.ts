// Signals against a fake Firecrawl and a fake Claude.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { sendStream } from './sse.ts';

process.env.NODE_ENV = 'test';
process.env.API_KEY = 'test-key';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rct-signals-'));
process.env.ANTHROPIC_API_KEY = 'fake';
process.env.FIRECRAWL_API_KEY = 'fake';

const searches: any[] = [];
let prompt = '';
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    if (req.url === '/v2/search') {
      searches.push(JSON.parse(body));
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ success: true, data: { web: [
        { url: 'https://www.reddit.com/r/newcastle/comments/1/any_web_designers', title: 'Can anyone recommend a web designer in Newcastle?', description: 'Opening a café in Jesmond and need a website.' },
        { url: 'https://x.com/agency/status/2', title: 'We build websites!', description: 'Book a call with our agency today.' },
      ] } }));
    }
    if (req.url === '/v1/messages') {
      prompt = body;
      return sendStream(res, { id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: JSON.stringify({ items: [
          { n: 1, genuine: true, service: 'new website', area: 'Newcastle', who: 'a café in Jesmond', summary: 'A new café owner wants a website.', reply: 'Congratulations on the café. Get your menu and opening hours on Google first. Happy to help, Red Cherry IT.' },
          { n: 2, genuine: false, service: '', area: '', who: '', summary: '', reply: '' },
        ] }) }], usage: { input_tokens: 1500, output_tokens: 300 } });
    }
    res.statusCode = 404;
    res.end();
  });
});

let app: any;
const headers = { 'x-api-key': 'test-key' };
before(async () => {
  await new Promise<void>(ok => fake.listen(0, '127.0.0.1', () => ok()));
  const url = `http://127.0.0.1:${(fake.address() as any).port}`;
  process.env.ANTHROPIC_BASE_URL = url;
  process.env.FIRECRAWL_API_URL = url;
  app = (await import('../src/server.ts')).buildApp();
  (await import('../src/copy.ts')).seed();
});
after(async () => { await app.close(); fake.close(); });

async function scan() {
  const { job } = (await app.inject({ method: 'POST', url: '/signals/scan', headers })).json();
  for (;;) {
    const r = (await app.inject({ method: 'GET', url: `/jobs/${job}`, headers })).json();
    if (r.done) return r.result;
    await new Promise(ok => setTimeout(ok, 20));
  }
}

test('a search keeps the real requests, and each post is only looked at once', async () => {
  const r = await scan();
  assert.deepEqual(r, { searched: 4, found: 2, checked: 2, added: 1 });
  assert.ok(searches.every(s => s.tbs === 'qdr:w' && s.query.includes('site:reddit.com')), 'past week, public sites only');
  assert.match(prompt, /Newcastle upon Tyne/);
  const list = (await app.inject({ method: 'GET', url: '/signals', headers })).json();
  assert.equal(list.signals.length, 1);
  assert.equal(list.signals[0].site, 'reddit.com');
  assert.match(list.signals[0].reply, /café/);
  prompt = '';
  const again = await scan();
  assert.equal(again.checked, 0);
  assert.equal(prompt, '', 'Claude is not asked about posts it has seen');
  assert.equal((await app.inject({ method: 'GET', url: '/dashboard/sales', headers })).json().needs.signals_new, 1);
});

test('a signal becomes a lead once, with the post and reply in its notes', async () => {
  const id = (await app.inject({ method: 'GET', url: '/signals', headers })).json().signals[0].id;
  const first = (await app.inject({ method: 'POST', url: `/signals/${id}/lead`, headers })).json();
  const second = (await app.inject({ method: 'POST', url: `/signals/${id}/lead`, headers })).json();
  assert.equal(first.lead_id, second.lead_id);
  const lead = (await app.inject({ method: 'GET', url: `/leads/${first.lead_id}`, headers })).json();
  assert.equal(lead.company_name, 'a café in Jesmond');
  assert.equal(lead.source, 'signal');
  assert.match(lead.activity[0].text, /reddit\.com[\s\S]*Suggested reply/);
  assert.equal((await app.inject({ method: 'GET', url: '/signals', headers })).json().signals.length, 0, 'no longer new');
  assert.equal((await app.inject({ method: 'GET', url: '/signals?all=true', headers })).json().signals[0].status, 'lead');
});
