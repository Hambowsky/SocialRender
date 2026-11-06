// Search Console watch against a fake Google sign in and API.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.NODE_ENV = 'test';
process.env.API_KEY = 'test-key';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rct-gsc-'));
process.env.GSC_CREDENTIALS = Buffer.from(JSON.stringify({ client_email: 'studio@rct.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) })).toString('base64');

const queries: any[] = [];
let tokens = 0;
const row = (keys: string[], clicks: number, impressions: number, position: number) => ({ keys, clicks, impressions, ctr: clicks / impressions, position });
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/token') {
      const jwt = new URLSearchParams(body).get('assertion')!.split('.');
      assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${jwt[0]}.${jwt[1]}`), publicKey, Buffer.from(jwt[2], 'base64url')), 'signed with the service account key');
      assert.match(Buffer.from(jwt[1], 'base64url').toString(), /webmasters\.readonly/);
      tokens++;
      return res.end(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
    }
    assert.equal(req.headers.authorization, 'Bearer tok');
    assert.equal(req.url, '/sites/sc-domain%3Aredcherryit.com/searchAnalytics/query');
    const q = JSON.parse(body);
    queries.push(q);
    const thisWeek = q.endDate === '2026-11-03';
    const rows = !q.dimensions.length ? [row([], thisWeek ? 120 : 100, 4000, thisWeek ? 18.2 : 19)]
      : q.dimensions[0] === 'page' ? (thisWeek ? [row(['https://redcherryit.com/pricing'], 40, 900, 6), row(['https://redcherryit.com/guides/learn/seo'], 5, 300, 12)]
        : [row(['https://redcherryit.com/pricing'], 20, 800, 7), row(['https://redcherryit.com/guides/learn/seo'], 15, 400, 9)])
      : [row(['web design durham'], 2, 400, 11.4), row(['website cost uk'], 1, 250, 14), row(['red cherry it'], 30, 60, 1), row(['rare search'], 0, 5, 12)];
    res.end(JSON.stringify({ rows }));
  });
});
let app: any;
const headers = { 'x-api-key': 'test-key' };
before(async () => {
  await new Promise<void>(ok => fake.listen(0, '127.0.0.1', () => ok()));
  const url = `http://127.0.0.1:${(fake.address() as any).port}`;
  process.env.GSC_TOKEN_URL = `${url}/token`;
  process.env.GSC_API_URL = url;
  app = (await import('../src/server.ts')).buildApp();
});
after(async () => { await app.close(); fake.close(); });

test('the Search Console watch compares last week with the one before and finds searches we nearly rank for', async () => {
  const { week, planFocus } = await import('../src/gsc.ts');
  const g = await week(new Date('2026-11-06T12:00:00Z'));
  assert.deepEqual([g.from, g.to], ['2026-10-28', '2026-11-03'], 'the week ends three days ago, when the figures have settled');
  assert.equal(g.totals.clicks, 120);
  assert.equal(g.totals.before.clicks, 100);
  assert.deepEqual(g.rising.map((m: any) => [m.page, m.change]), [['https://redcherryit.com/pricing', 20]]);
  assert.deepEqual(g.falling.map((m: any) => [m.page, m.change]), [['https://redcherryit.com/guides/learn/seo', -10]]);
  assert.deepEqual(g.chances.map((c: any) => c.query), ['web design durham', 'website cost uk'], 'positions 8 to 20 with enough impressions');
  const calls = queries.length;
  await week(new Date('2026-11-06T18:00:00Z'));
  assert.equal(queries.length, calls, 'asked once a day');
  assert.equal(tokens, 1, 'the sign in is reused');
  assert.equal((await app.inject({ method: 'GET', url: '/search-console', headers })).statusCode, 200);
  assert.match(await planFocus(), /"web design durham", "website cost uk"/);
});
