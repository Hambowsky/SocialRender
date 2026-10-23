import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.API_KEY = 'test-key';
process.env.PUBLIC_URL = 'https://studio.example';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rct-'));

const { buildApp } = await import('../src/server.ts');
const { seed, sampleOf, current } = await import('../src/templates.ts');
const { closeBrowser } = await import('../src/render.ts');

seed();
const app = buildApp();
after(async () => { await app.close(); await closeBrowser(); });
const rpc = (body: object, key = 'test-key') => app.inject({ method: 'POST', url: '/mcp', headers: { 'x-api-key': key }, payload: { jsonrpc: '2.0', ...body } });

test('MCP needs the API key', async () => {
  assert.equal((await rpc({ id: 1, method: 'tools/list' }, 'wrong')).statusCode, 401);
});

test('MCP handshake, tool list and a notification', async () => {
  const init = (await rpc({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })).json();
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools);
  assert.equal((await rpc({ method: 'notifications/initialized' })).statusCode, 202);
  const tools = (await rpc({ id: 2, method: 'tools/list' })).json().result.tools;
  assert.ok(tools.some((t: any) => t.name === 'render_image' && t.inputSchema.required.includes('fields')));
  assert.ok(!tools.some((t: any) => /approve|publish|send/.test(t.name)), 'nothing that approves, publishes or sends');
  assert.equal((await rpc({ id: 3, method: 'nope' })).json().error.code, -32601);
});

test('MCP tools call the normal routes', async () => {
  const dash = (await rpc({ id: 1, method: 'tools/call', params: { name: 'sales_dashboard', arguments: {} } })).json().result;
  assert.equal(dash.isError, false);
  assert.ok('needs' in JSON.parse(dash.content[0].text));

  const fields = sampleOf(current('social-post').body);
  const img = (await rpc({ id: 2, method: 'tools/call', params: { name: 'render_image', arguments: { template: 'social-post', fields } } })).json().result;
  const r = JSON.parse(img.content[0].text);
  assert.match(r.render_id, /^[a-f0-9]{20}$/);
  assert.equal(r.image_url, `https://studio.example/public/renders/${r.render_id}.png`);

  const bad = (await rpc({ id: 3, method: 'tools/call', params: { name: 'render_image', arguments: { template: 'social-post', fields: { ...fields, headline: 'word '.repeat(40) } } } })).json().result;
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /does not fit/);
});

test('Hermes can create and read a campaign', async () => {
  const args = { name: 'Plumbers, Newcastle and Durham', industries: 'plumbers', towns: 'Newcastle upon Tyne, Durham', lead_type: 'both', max_leads: 50, sources: ['places', 'directories'] };
  const made = (await rpc({ id: 1, method: 'tools/call', params: { name: 'create_campaign', arguments: args } })).json().result;
  assert.equal(made.isError, false, made.content[0].text);
  const id = JSON.parse(made.content[0].text).id;
  const got = (await rpc({ id: 2, method: 'tools/call', params: { name: 'get_campaign', arguments: { id } } })).json().result;
  assert.match(got.content[0].text, /Durham/);
});
