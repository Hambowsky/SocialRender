// Links against a fake Firecrawl, a fake Claude and fake web pages.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { sendStream } from './sse.ts';

process.env.NODE_ENV = 'test';
process.env.API_KEY = 'test-key';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rct-links-'));
process.env.ANTHROPIC_API_KEY = 'fake';
process.env.FIRECRAWL_API_KEY = 'fake';

// The pages sit on a public test address (pages are only read from public addresses), answered here without the network.
const PAGES = 'http://203.0.113.7';
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith(PAGES)) return realFetch(input, init);
  return new Response(url.endsWith('/linked') ? '<a href="https://redcherryit.com">Red Cherry IT</a>' : '<p>Thanks to Red Cherry IT</p>', { headers: { 'content-type': 'text/html' } });
}) as typeof fetch;
let base = '', prompt = '', claudeCalls = 0;
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    if (req.url === '/v2/search') {
      const q = JSON.parse(body).query as string;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ success: true, data: { web: q.includes('journo')
        ? [{ url: 'https://x.com/reporter/status/1', title: '#journorequest Looking for web designers on why trades need a website', description: 'Deadline Friday 5pm.' },
           { url: 'https://x.com/pr/status/2', title: 'We get you press!', description: 'PR packages.' }]
        : [{ url: `${PAGES}/linked`, title: 'North East agencies', description: 'Red Cherry IT built our site.' },
           { url: `${PAGES}/unlinked`, title: 'Our new website', description: 'Thanks to Red Cherry IT for the new site.' }] } }));
    }
    if (req.url === '/v1/messages') {
      prompt = body; claudeCalls++;
      return sendStream(res, { id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: JSON.stringify({ items: [
          { n: 1, keep: true, summary: 'A reporter wants views on why trades need a website.', deadline: 'Friday 5pm', reply: 'Most trades win work from a Google search.' },
          { n: 2, keep: false, summary: '', deadline: '', reply: '' },
          { n: 3, keep: true, summary: 'A client thanks us without a link.', deadline: '', reply: 'Thank you for the mention. Could you link Red Cherry IT?' },
        ] }) }], usage: { input_tokens: 1500, output_tokens: 300 } });
    }
    res.statusCode = 404;
    res.end();
  });
});
let app: any, headers: Record<string, string>;
before(async () => {
  await new Promise<void>(ok => fake.listen(0, '127.0.0.1', () => ok()));
  base = `http://127.0.0.1:${(fake.address() as any).port}`;
  process.env.FIRECRAWL_API_URL = base;
  process.env.ANTHROPIC_BASE_URL = base;
  const { buildApp } = await import('../src/server.ts');
  app = buildApp();
  (await import('../src/copy.ts')).seed();
  headers = { 'x-api-key': 'test-key' };
});
after(async () => { await app.close(); fake.close(); });

test('the link search keeps real journalist requests and mentions that do not link to us, once', async () => {
  const scan = async () => {
    const { job } = (await app.inject({ method: 'POST', url: '/links/scan', headers })).json();
    for (;;) {
      const r = (await app.inject({ method: 'GET', url: `/jobs/${job}`, headers })).json();
      if (r.done !== false) { if (r.error) throw new Error(r.error); return r.result; }
      await new Promise(ok => setTimeout(ok, 20));
    }
  };
  assert.deepEqual(await scan(), { searched: 4, found: 4, checked: 3, added: 2 });
  assert.doesNotMatch(prompt, /\/linked/, 'a page that already links to us never reaches Claude');
  const list = (await app.inject({ method: 'GET', url: '/links', headers })).json().links;
  assert.deepEqual(list.map((l: any) => l.kind).sort(), ['mention', 'request']);
  assert.equal(list.find((l: any) => l.kind === 'request').deadline, 'Friday 5pm');
  assert.equal((await app.inject({ method: 'GET', url: '/dashboard/marketing', headers })).json().needs.links_new, 2);

  const calls = claudeCalls;
  await scan();
  assert.equal(claudeCalls, calls, 'pages already looked at are not sent to Claude again');

  const id = list[0].id;
  assert.equal((await app.inject({ method: 'POST', url: `/links/${id}/done`, headers })).json().status, 'done');
  assert.equal((await app.inject({ method: 'POST', url: `/links/${id}/dismiss`, headers })).json().status, 'done', 'a second click changes nothing');
  assert.equal((await app.inject({ method: 'GET', url: '/links', headers })).json().links.length, 1);
});
