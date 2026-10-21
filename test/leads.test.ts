// Sales campaigns against fake Google Places and Firecrawl servers, so no paid search is ever made.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.API_KEY = 'test-key';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rct-leads-'));
process.env.GOOGLE_PLACES_API_KEY = 'fake';
process.env.FIRECRAWL_API_KEY = 'fake';
process.env.ANTHROPIC_API_KEY = 'fake';

const calls = { places: 0, firecrawl: 0 };
const claude: any[] = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/places:searchText') {
      calls.places++;
      assert.match(String(req.headers['x-goog-fieldmask']), /places\.websiteUri/);
      return res.end(JSON.stringify({ places: [
        { id: 'p1', displayName: { text: 'Smith Plumbing Ltd' }, nationalPhoneNumber: '0114 496 0000', businessStatus: 'OPERATIONAL', rating: 4.8, userRatingCount: 31,
          formattedAddress: '1 High St, Sheffield S1 2AB', addressComponents: [{ longText: 'No types here' }, { longText: 'S1 2AB', types: ['postal_code'] }, { longText: 'Sheffield', types: ['postal_town'] }] },
        // A private address is refused by the checker, so it reads as a site that does not load.
        { id: 'p2', displayName: { text: 'Dead Site Plumbers' }, websiteUri: 'http://127.0.0.1:9/', businessStatus: 'OPERATIONAL' },
        { id: 'p3', displayName: { text: 'Closed Plumbing' }, businessStatus: 'CLOSED_PERMANENTLY' },
      ] }));
    }
    if (req.url === '/v1/places:autocomplete') {
      calls.places++;
      if (JSON.parse(body).input === 'denied') { res.statusCode = 403; return res.end(JSON.stringify({ error: { message: 'Places API (New) has not been used in project 123 before or it is disabled.' } })); }
      assert.deepEqual(JSON.parse(body).includedRegionCodes, ['gb']);
      return res.end(JSON.stringify({ suggestions: [{ placePrediction: { structuredFormat: { mainText: { text: 'Newcastle upon Tyne' }, secondaryText: { text: 'UK' } } } }, { queryPrediction: {} }] }));
    }
    if (req.url?.startsWith('/v1/places/p')) {
      calls.places++;
      return res.end(JSON.stringify({ rating: 4.8, userRatingCount: 31, photos: [{}, {}], googleMapsUri: 'https://maps.google.com/?cid=1' }));
    }
    if (req.url === '/v1/messages') {
      claude.push(JSON.parse(body));
      return res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: JSON.stringify({ priority: 'hot', notes: 'Great reviews and no website.', pitch: 'Your 31 reviews deserve a website to send people to.' }) }],
        usage: { input_tokens: 3000, output_tokens: 100 } }));
    }
    if (req.url === '/v2/search') {
      calls.firecrawl++;
      const { query } = JSON.parse(body);
      const web = query.includes('site:yell.com') ? [{ title: 'Jones Heating - Plumbers in Sheffield | Yell', url: 'https://www.yell.com/biz/jones', description: 'Call 0114 496 0123 or info@jonesheating.co.uk' },
        { title: 'Smith Plumbing - Yell', url: 'https://www.yell.com/biz/smith', description: '' }] : [];
      return res.end(JSON.stringify({ success: true, data: { web }, creditsUsed: 2 }));
    }
    res.statusCode = 404; res.end('{}');
  });
});

let app: any;
const headers = { 'x-api-key': 'test-key' };
before(async () => {
  await new Promise<void>(ok => fake.listen(0, '127.0.0.1', () => ok()));
  process.env.ANTHROPIC_BASE_URL = process.env.GOOGLE_PLACES_URL = process.env.FIRECRAWL_API_URL = `http://127.0.0.1:${(fake.address() as any).port}`;
  app = (await import('../src/server.ts')).buildApp();
  (await import('../src/copy.ts')).seed();
});
after(async () => { await app.close(); fake.close(); await (await import('../src/render.ts')).closeBrowser(); });

async function runToEnd(id: number) {
  assert.equal((await app.inject({ method: 'POST', url: `/campaigns/${id}/run`, headers })).statusCode, 202);
  for (let i = 0; i < 100; i++) {
    const c = (await app.inject({ method: 'GET', url: `/campaigns/${id}`, headers })).json();
    if (c.status !== 'running') return c;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('run did not finish');
}

test('the HTML checks find old, insecure and unfriendly sites and their contact details', async () => {
  const { analyse, findEmail } = await import('../src/sitecheck.ts');
  const old = analyse(`<html><head><title>Bob</title></head><body><img src=a.png><img src=b.png alt="">
    <a href="https://www.facebook.com/bobsplumbing">fb</a><a href="https://www.facebook.com/sharer/sharer.php?u=x">share</a>
    <a href="mailto:bob@bobsplumbing.co.uk">Email</a><footer>&copy; 2019 Bob</footer></body></html>`, 'http://bob.example', 2026);
  assert.deepEqual(old.issues, { no_ssl: true, no_mobile_viewport: true, old_copyright_year: 2019 });
  assert.equal(old.seo.no_h1, true);
  assert.equal(old.seo.images_missing_alt, 1);
  assert.equal(old.email, 'bob@bobsplumbing.co.uk');
  assert.deepEqual(old.social, { facebook: 'https://www.facebook.com/bobsplumbing' });
  const good = analyse(`<head><title>A</title><meta name="viewport" content="width=device-width"></head><p>© 2025</p>`, 'https://a.example', 2026);
  assert.deepEqual(good.issues, {});
  assert.equal(findEmail('logo@2x.png and test@example.com then hi@real.co.uk'), 'hi@real.co.uk');
  const cf = (e: string) => '42' + [...e].map(c => (c.charCodeAt(0) ^ 0x42).toString(16).padStart(2, '0')).join('');
  assert.equal(findEmail(`<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="${cf('jo@plumb.co.uk')}">[email&#160;protected]</a>`), 'jo@plumb.co.uk');
  assert.equal(findEmail(`<a href="/cdn-cgi/l/email-protection#${cf('a@b.com')}">Email us</a>`), 'a@b.com');
  assert.equal(findEmail('Email: sales&#64;roofs&#46;co&#46;uk'), 'sales@roofs.co.uk');
  assert.equal(findEmail('office [at] smith-joinery [dot] co [dot] uk'), 'office@smith-joinery.co.uk');
});

test('town suggestions come from Google without the comma, and are cached', async () => {
  const get = async (q: string) => (await app.inject({ method: 'GET', url: `/campaigns/towns?q=${q}`, headers })).json();
  assert.deepEqual(await get('Newc'), [{ name: 'Newcastle upon Tyne', area: 'UK' }]);
  const n = calls.places;
  assert.deepEqual(await get('newc'), [{ name: 'Newcastle upon Tyne', area: 'UK' }]);
  assert.equal(calls.places, n, 'second ask comes from the cache');
  assert.deepEqual(await get('N'), [], 'too short to ask');
  const bad = await app.inject({ method: 'GET', url: '/campaigns/towns?q=denied', headers });
  assert.equal(bad.statusCode, 502);
  assert.match(bad.json().message, /Places API \(New\) has not been used/);
});

test('a campaign finds businesses with no website or a dead one, once each', async () => {
  const bad = await app.inject({ method: 'POST', url: '/campaigns', headers, payload: { name: 'x', industries: 'a,b,c,d,e,f', towns: '1,2,3,4,5', lead_type: 'both', max_leads: 10, sources: ['places'] } });
  assert.equal(bad.statusCode, 400, 'too many searches in one campaign');

  const c = (await app.inject({ method: 'POST', url: '/campaigns', headers,
    payload: { name: 'Sheffield plumbers', industries: 'plumber', towns: 'Sheffield', lead_type: 'no_website', max_leads: 50, sources: ['places', 'directories'] } })).json();
  const done = await runToEnd(c.id);
  assert.equal(done.status, 'done', JSON.stringify(done.last_run_summary));
  const leads = (await app.inject({ method: 'GET', url: '/leads', headers })).json();
  assert.deepEqual(leads.map((l: any) => l.company_name).sort(), ['Dead Site Plumbers', 'Jones Heating', 'Smith Plumbing Ltd']);
  const jones = leads.find((l: any) => l.company_name === 'Jones Heating');
  assert.equal(jones.email, 'info@jonesheating.co.uk');
  assert.equal(jones.phone, '0114 496 0123');
  assert.equal(jones.source, 'yell.com');
  assert.equal(leads.find((l: any) => l.company_name === 'Dead Site Plumbers').lead_reason, 'Website listed but unreachable');
  assert.equal(done.last_run_summary.added, 3);
  assert.deepEqual([done.last_run_summary.google_searches, done.last_run_summary.google_cost_gbp, done.last_run_summary.firecrawl_searches, done.last_run_summary.firecrawl_credits], [1, 0, 8, 16]);

  // Running again finds the same businesses but adds none, and the searches come from the cache at no cost.
  const before = { ...calls };

  const again = await runToEnd(c.id);
  assert.equal(again.last_run_summary.added, 0);
  assert.equal(again.last_run_summary.google_searches, 0, 'repeat searches cost nothing');
  const usage = (await app.inject({ method: 'GET', url: '/campaigns/usage', headers })).json();
  assert.deepEqual(usage, { google_searches: 1, google_free: 1000, google_cost_gbp: 0, firecrawl_searches: 8, firecrawl_credits: 16 });
  assert.deepEqual(calls, before);
  const list = async (q: string) => (await app.inject({ method: 'GET', url: `/leads?${q}`, headers })).json();
  const all = await list('');
  assert.equal((await list('has_email=yes')).length, 1);
  for (const key of ['has_website', 'has_email', 'has_phone']) {
    const [yes, no] = [await list(`${key}=yes`), await list(`${key}=no`)];
    assert.equal(yes.length + no.length, all.length, `${key} yes and no cover every lead`);
  }
  assert.ok((await list('has_website=no')).every((l: { has_website: number }) => !l.has_website));
  assert.deepEqual((await list('sort=name')).map((l: { company_name: string }) => l.company_name),
    all.map((l: { company_name: string }) => l.company_name).sort((a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' })));
  assert.equal((await list('status=active')).length, all.length);
  assert.equal((await list('status=contacted_plus')).length, 0);
});

test('an outdated website campaign skips businesses with no site at all', async () => {
  const c = (await app.inject({ method: 'POST', url: '/campaigns', headers,
    payload: { name: 'Leeds', industries: 'plumber', towns: 'Leeds', lead_type: 'outdated_website', max_leads: 10, sources: ['places'] } })).json();
  const done = await runToEnd(c.id);
  assert.equal(done.last_run_summary.added, 0);
});

test('analysing a lead adds its Business Profile and Claude\'s priority, note and opening line', async () => {
  const smith = (await app.inject({ method: 'GET', url: '/leads?q=Smith', headers })).json()[0];
  const l = (await app.inject({ method: 'POST', url: `/leads/${smith.id}/analyse`, headers })).json();
  assert.equal(l.priority, 'hot');
  assert.equal(l.analysis.pitch, 'Your 31 reviews deserve a website to send people to.');
  assert.deepEqual(l.analysis.gbp, { rating: 4.8, reviews: 31, has_hours: false, photos: 2, maps_url: 'https://maps.google.com/?cid=1' });
  assert.deepEqual(l.analysis.errors, []);
  const prompt = JSON.stringify(claude.at(-1).messages);
  assert.match(prompt, /4\.8 stars from 31 reviews, no opening hours, 2 photos/);
  assert.match(prompt, /Website: none/);
  assert.equal((await app.inject({ method: 'GET', url: '/leads?priority=hot', headers })).json().length, 1);

  // The rest of the campaign in the background. The dead site is tried once more for a screenshot and email, and still does not load.
  const camp = (await app.inject({ method: 'POST', url: `/campaigns/${smith.campaign_id}/analyse`, headers })).json();
  assert.equal(camp.total, 2);
  for (let i = 0; i < 100 && (await app.inject({ method: 'GET', url: `/campaigns/${smith.campaign_id}`, headers })).json().analysis_progress; i++) await new Promise(r => setTimeout(r, 50));
  const c = (await app.inject({ method: 'GET', url: `/campaigns/${smith.campaign_id}`, headers })).json();
  assert.equal(c.analysed, 3);
  const dead = (await app.inject({ method: 'GET', url: '/leads?q=Dead', headers })).json()[0];
  assert.match((await app.inject({ method: 'GET', url: `/leads/${dead.id}`, headers })).json().analysis.errors.join(), /^Screenshot: /);
  assert.equal((await app.inject({ method: 'POST', url: `/campaigns/${smith.campaign_id}/analyse`, headers })).statusCode, 400, 'nothing left to analyse');
});

test('a lead keeps its status changes and notes, and survives deleting its campaign once worked on', async () => {
  const [first, second] = (await app.inject({ method: 'GET', url: '/leads', headers })).json();
  let l = (await app.inject({ method: 'PUT', url: `/leads/${first.id}`, headers, payload: { status: 'contacted', follow_up_date: '2026-11-02' } })).json();
  l = (await app.inject({ method: 'POST', url: `/leads/${first.id}/notes`, headers, payload: { text: 'Called, ring back Monday' } })).json();
  assert.equal(l.status, 'contacted');
  assert.deepEqual(l.activity.map((a: any) => a.text), ['Called, ring back Monday', 'Status changed from new to contacted']);
  assert.deepEqual((await app.inject({ method: 'GET', url: '/leads?status=contacted_plus', headers })).json().map((x: any) => x.id), [first.id]);
  assert.equal((await app.inject({ method: 'PUT', url: `/leads/${first.id}`, headers, payload: { status: 'nonsense' } })).statusCode, 400);

  const del = (await app.inject({ method: 'DELETE', url: `/campaigns/${first.campaign_id}`, headers })).json();
  assert.equal(del.leads_removed, 2);
  assert.equal((await app.inject({ method: 'GET', url: `/leads/${second.id}`, headers })).statusCode, 404);
  const kept = (await app.inject({ method: 'GET', url: `/leads/${first.id}`, headers })).json();
  assert.equal(kept.campaign_id, null);
});
