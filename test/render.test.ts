import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.API_KEY = 'test-key';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rct-'));
const OUT = process.env.RENDER_SAMPLES_DIR; // set this to keep a copy of each sample PNG for checking by eye

const { buildApp } = await import('../src/server.ts');
const { seed, list, sampleOf, current } = await import('../src/templates.ts');
const { closeBrowser } = await import('../src/render.ts');

seed();
const app = buildApp();
const headers = { 'x-api-key': 'test-key' };
after(async () => { await app.close(); await closeBrowser(); });

const pngSize = (buf: Buffer) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });
const names = (list() as { name: string }[]).map(t => t.name);

test('there are four image and four motion templates', () => {
  assert.deepEqual(names, ['motion-blueprint', 'motion-glow', 'motion-isometric', 'motion-whiteboard', 'quote-card', 'social-post', 'stat-card', 'tip-card']);
});

for (const name of names) {
  const height = name.startsWith('motion-') ? 1920 : 1080;
  test(`${name} renders its sample text at 1080 by ${height}`, async () => {
    const fields = sampleOf(current(name).body);
    const res = await app.inject({ method: 'POST', url: '/render', headers, payload: { template: name, fields } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.deepEqual(pngSize(res.rawPayload), { width: 1080, height });
    if (OUT) fs.writeFileSync(path.join(OUT, `${name}.png`), res.rawPayload);
  });
}

test('an overlong headline is rejected with the field and how much to cut', async () => {
  const fields = { ...sampleOf(current('social-post').body), headline: 'Why speed matters. Fast sites explained in plain English for every small business owner' };
  const res = await app.inject({ method: 'POST', url: '/render', headers, payload: { template: 'social-post', fields } });
  assert.equal(res.statusCode, 422);
  const problem = res.json().problems.find((p: any) => p.field === 'headline');
  assert.ok(problem, res.body);
  assert.ok(problem.overflow_px > 0 && problem.shorten_by_chars > 0, res.body);
});

test('a motion template makes a 12 second upright MP4, once', async () => {
  const payload = { template: 'motion-glow', fields: sampleOf(current('motion-glow').body) };
  const a = await app.inject({ method: 'POST', url: '/render/video', headers, payload });
  assert.equal(a.statusCode, 200, a.body);
  const video = await app.inject({ method: 'GET', url: a.json().url });
  assert.equal(video.headers['content-type'], 'video/mp4');
  assert.equal(video.rawPayload.subarray(4, 8).toString(), 'ftyp');
  const b = await app.inject({ method: 'POST', url: '/render/video', headers, payload });
  assert.equal(b.json().id, a.json().id);
});

test('an image template cannot be made into a video', async () => {
  const res = await app.inject({ method: 'POST', url: '/render/video', headers, payload: { template: 'tip-card', fields: sampleOf(current('tip-card').body) } });
  assert.equal(res.statusCode, 400, res.body);
});

test('a retry with the same text returns the same render', async () => {
  const payload = { template: 'tip-card', fields: sampleOf(current('tip-card').body) };
  const a = await app.inject({ method: 'POST', url: '/render?format=json', headers, payload });
  const b = await app.inject({ method: 'POST', url: '/render?format=json', headers, payload });
  assert.equal(a.json().id, b.json().id);
});

test('requests without the key are refused, health is open', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/templates' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
});

test('saving and rolling back a template keeps versions', async () => {
  const before = current('social-post');
  const edited = before.body.replace('font-size: 92px', 'font-size: 90px');
  const saved = await app.inject({ method: 'PUT', url: '/templates/social-post', headers, payload: { html: edited, note: 'test' } });
  assert.equal(saved.statusCode, 200, saved.body);
  const back = await app.inject({ method: 'POST', url: `/templates/social-post/rollback/${before.id}`, headers });
  assert.equal(back.statusCode, 200, back.body);
  assert.equal(current('social-post').body, before.body);
});
