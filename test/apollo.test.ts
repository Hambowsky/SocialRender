// Apollo against a fake server: companies for a campaign, the person to write to, and the monthly credit cap.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.API_KEY = 'test-key';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rct-apollo-'));
process.env.APOLLO_API_KEY = 'ak';
process.env.APOLLO_MONTHLY_CREDITS = '3';

const seen: { url: string; body: any; key: string }[] = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const b = JSON.parse(body || '{}');
    seen.push({ url: req.url!, body: b, key: String(req.headers['x-api-key']) });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/v1/mixed_companies/search') return res.end(JSON.stringify({ organizations: [
      { id: 'o1', name: 'Pipe Pros Ltd', website_url: 'http://www.pipepros.co.uk', primary_phone: { number: '0114 496 0000' } }, { id: 'o2', name: null }] }));
    if (req.url === '/api/v1/mixed_people/api_search') return res.end(JSON.stringify({ people: b.q_organization_domains_list[0] === 'nobody.example' ? []
      : [{ id: 'x', has_email: false }, { id: 'p1', has_email: true }] }));
    if (req.url === '/api/v1/people/bulk_match') return res.end(JSON.stringify({ credits_consumed: 1, matches: [{ id: 'p1', first_name: 'Sam', last_name: 'Pipe', name: 'Sam Pipe',
      title: 'Owner', email: 'sam@pipepros.co.uk', email_status: 'verified', linkedin_url: 'http://linkedin.com/in/sam',
      organization: { estimated_num_employees: 6, founded_year: 2009, industry: 'construction', short_description: 'Family run plumbers in Sheffield.' } }] }));
    res.statusCode = 404; res.end('{}');
  });
});
let apollo: typeof import('../src/apollo.ts');
before(async () => {
  await new Promise<void>(ok => fake.listen(0, '127.0.0.1', () => ok()));
  process.env.APOLLO_API_URL = `http://127.0.0.1:${(fake.address() as any).port}`;
  apollo = await import('../src/apollo.ts');
});
after(() => fake.close());

test('a campaign search finds UK companies by industry and town, for 1 credit a page', async () => {
  const found = await apollo.companies('Plumbers', 'Sheffield', 20);
  assert.deepEqual(seen[0].body.organization_locations, ['Sheffield, United Kingdom']);
  assert.deepEqual(seen[0].body.q_organization_keyword_tags, ['Plumbers', 'Plumber']);
  assert.equal(seen[0].key, 'ak');
  assert.equal(found.length, 1, 'nameless companies are dropped');
  assert.equal(found[0].company_name, 'Pipe Pros Ltd');
  assert.equal(found[0].phone, '0114 496 0000');
  assert.equal(found[0].source, 'apollo');
  await apollo.companies('Plumbers', 'Sheffield', 20);
  assert.equal(seen.length, 1, 'the same search the same day comes from the cache');
  assert.equal(apollo.creditsUsed(), 1);
});

test('the decision maker is found free, and only the chosen one is paid for', async () => {
  const f = await apollo.find('pipepros.co.uk');
  assert.equal(seen.at(-2)!.url, '/api/v1/mixed_people/api_search');
  assert.deepEqual(seen.at(-1)!.body.details, [{ id: 'p1' }], 'the first person with an email');
  assert.equal(f.person!.name, 'Sam Pipe');
  assert.equal(f.person!.email_status, 'verified');
  assert.equal(f.company!.employees, 6);
  assert.match(apollo.describe(f), /Decision maker: Sam Pipe, Owner\nabout 6 staff, founded 2009, construction\nAbout them: Family run plumbers/);
  assert.equal(apollo.creditsUsed(), 2);
  const none = await apollo.find('nobody.example');
  assert.equal(none.person, null);
  assert.equal(apollo.describe(none), 'none');
  assert.equal(apollo.creditsUsed(), 2, 'nobody found costs nothing');
});

test('the monthly credit cap stops paid calls', async () => {
  await apollo.companies('Roofers', 'Leeds', 10); // the third credit
  await assert.rejects(apollo.companies('Roofers', 'York', 10), /3 Apollo credits are used up/);
});
