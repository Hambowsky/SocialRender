import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyReply } from 'fastify';
import { API_KEY, CLAUDE_MONTHLY_CAP_GBP, fail, IMAP_HOST, OUTREACH_DAILY_CAP, HOST, MAX_FIELD_CHARS, PORT, RENDERS_PER_MIN, ROOT } from './config.ts';
import { db } from './db.ts';
import { closeBrowser, publicFile, render, renderPath, renderVideo } from './render.ts';
import { current, fieldsOf, fill, list, rollback, sampleOf, save, seed, sizesOf, versions } from './templates.ts';
import { NAME_PATTERN } from './versions.ts';
import * as prompts from './copy.ts';
import { monthSpendGbp } from './claude.ts';
import { startCleanup } from './cleanup.ts';
import * as buffer from './buffer.ts';
import * as posts from './posts.ts';
import * as articles from './articles.ts';
import * as leads from './leads.ts';
import { analyseCampaign, analyseLead } from './analyse.ts';
import * as outreach from './outreach.ts';
import { inboxState, startInbox } from './inbox.ts';
import { esc } from './markdown.ts';

type Fields = Record<string, string>;
const name = { type: 'string', pattern: NAME_PATTERN };
const fields = { type: 'object', maxProperties: 20, additionalProperties: { type: 'string', maxLength: MAX_FIELD_CHARS } };
const oneOff = { type: 'string', maxLength: 60000 };
const size = { type: 'string', pattern: '^\\d{3,4}x\\d{3,4}$' };
const nameParams = { type: 'object', properties: { name } };

// ponytail: one fixed one-minute window per route group, in memory. Fine for a single process and a single key.
const windows = new Map<string, { start: number; count: number }>();
function allow(group: string, limit: number) {
  const now = Date.now();
  let w = windows.get(group);
  if (!w || now - w.start >= 60_000) windows.set(group, (w = { start: now, count: 0 }));
  return ++w.count <= limit;
}

function keyMatches(given: unknown) {
  const a = Buffer.from(String(given ?? '')), b = Buffer.from(API_KEY);
  return API_KEY !== '' && a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function buildApp() {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test', bodyLimit: 256 * 1024 });

  // The editor page, fonts, logo and check script hold nothing private and must load without a header.
  // Everything else needs the key.
  app.addHook('onRequest', async (req, reply) => {
    const p = req.url.split('?')[0];
    if (p === '/health' || p === '/' || p === '/unsubscribe' || publicFile(p) || p.startsWith('/public/renders/')) return;
    if (!keyMatches(req.headers['x-api-key'])) return reply.code(401).send({ error: 'Missing or wrong API key' });
    const group = p === '/render' || p === '/render/video' ? 'render' : p === '/copy' || p === '/templates/design' || p === '/templates/tweak' || p === '/articles' && req.method === 'POST' || p.endsWith('/social') || p.endsWith('/test') || p.endsWith('/research') || p.endsWith('/sources') || p.endsWith('/analyse') || p.endsWith('/email') ? 'claude' : 'other';
    if (!allow(group, { render: RENDERS_PER_MIN, claude: 20, other: 600 }[group]))
      return reply.code(429).header('retry-after', '60').send({ error: 'Rate limit reached. Try again in a minute.' });
  });

  app.get('/health', async () => {
    db.prepare('SELECT 1').get();
    return { ok: true };
  });

  app.get('/', (_req, reply) => reply.type('text/html; charset=utf-8').send(fs.createReadStream(path.join(ROOT, 'public', 'editor.html'))));
  const sendPublic = (req: { url: string }, reply: any) => {
    const f = publicFile(req.url.split('?')[0]);
    return f ? reply.type(f.type).send(fs.createReadStream(f.file)) : reply.code(404).send({ error: 'Not found' });
  };
  app.get('/check.js', sendPublic);
  app.get('/fonts/:file', sendPublic);
  app.get('/assets/:file', sendPublic);

  app.get('/templates', async () => list());

  app.get<{ Params: { name: string } }>('/templates/:name', { schema: { params: nameParams } }, async req => {
    const t = current(req.params.name);
    return { name: req.params.name, version: t.id, html: t.body, fields: fieldsOf(t.body), sample: sampleOf(t.body), sizes: sizesOf(t.body) };
  });

  app.put<{ Params: { name: string }; Body: { html: string; note?: string } }>('/templates/:name', {
    schema: {
      params: nameParams,
      body: { type: 'object', required: ['html'], properties: { html: { type: 'string', maxLength: 60000 }, note: { type: 'string', maxLength: 200 } } },
    },
  }, async req => ({ version: save(req.params.name, req.body.html, req.body.note) }));

  app.get<{ Params: { name: string } }>('/templates/:name/versions', { schema: { params: nameParams } }, async req => versions(req.params.name));

  app.post<{ Params: { name: string; version: number } }>('/templates/:name/rollback/:version', {
    schema: { params: { type: 'object', properties: { name, version: { type: 'integer' } } } },
  }, async req => ({ version: rollback(req.params.name, req.params.version) }));

  // Filled HTML for the editor's live preview. `html` previews unsaved template code.
  app.post<{ Body: { template: string; fields: Fields; html?: string; size?: string } }>('/preview', {
    schema: { body: { type: 'object', required: ['template', 'fields'], properties: { template: name, fields, size, html: { type: 'string', maxLength: 60000 } } } },
  }, async (req, reply) => {
    const html = req.body.html ?? current(req.body.template).body;
    return reply.type('text/html; charset=utf-8').send(fill(html, req.body.fields, req.body.size).html);
  });

  // `html` (optional) is a one off version of the template for this post, from /templates/tweak.
  app.post<{ Body: { template: string; fields: Fields; size?: string; html?: string }; Querystring: { format?: string } }>('/render', {
    schema: {
      body: { type: 'object', required: ['template', 'fields'], properties: { template: name, fields, size, html: oneOff } },
      querystring: { type: 'object', properties: { format: { enum: ['png', 'json'] } } },
    },
  }, async (req, reply) => {
    const result = await render(req.body.template, req.body.fields, req.body.size, req.body.html);
    if (!result.ok) return reply.code(422).send({ error: 'The text does not fit this template', problems: result.problems });
    const [width, height] = (req.body.size ?? current(req.body.template).body.match(/data-size="(\d+x\d+)"/)?.[1] ?? '1080x1080').split('x').map(Number);
    if (req.query.format === 'json') return { id: result.id, url: `/renders/${result.id}.png`, width, height };
    return reply.type('image/png').header('x-render-id', result.id)
      .header('content-disposition', `inline; filename="${req.body.template}-${result.id}.png"`)
      .send(fs.createReadStream(result.file));
  });

  // A motion template as an MP4 clip. Slow (it plays every frame), so callers wait on it.
  app.post<{ Body: { template: string; fields: Fields; size?: string; html?: string } }>('/render/video', {
    schema: { body: { type: 'object', required: ['template', 'fields'], properties: { template: name, fields, size, html: oneOff } } },
  }, async (req, reply) => {
    const result = await renderVideo(req.body.template, req.body.fields, req.body.size, req.body.html);
    if (!result.ok) return reply.code(422).send({ error: 'The text does not fit this template', problems: result.problems });
    return { id: result.id, url: `/public/renders/${result.id}.mp4` };
  });

  app.get<{ Params: { id: string } }>('/public/renders/:id.mp4', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', pattern: '^[a-f0-9]{20}$' } } } },
  }, async (req, reply) => {
    const file = renderPath(req.params.id, 'mp4');
    if (!fs.existsSync(file)) return reply.code(404).send({ error: 'Not found' });
    // Safari and iPhones only play a video when the server answers byte range requests.
    const size = fs.statSync(file).size;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    reply.type('video/mp4').header('accept-ranges', 'bytes');
    if (!m || !m[1] && !m[2]) return reply.header('content-length', size).send(fs.createReadStream(file));
    const start = m[1] ? +m[1] : Math.max(0, size - +m[2]), end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
    if (start > end) return reply.code(416).header('content-range', `bytes */${size}`).send();
    return reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', end - start + 1)
      .send(fs.createReadStream(file, { start, end }));
  });

  // Buffer fetches images from here, so it needs no key. Render ids are 80 bit random looking hashes,
  // so nobody can list or guess other images.
  app.get<{ Params: { id: string } }>('/public/renders/:id.png', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', pattern: '^[a-f0-9]{20}$' } } } },
  }, async (req, reply) => {
    const file = renderPath(req.params.id);
    return fs.existsSync(file) ? reply.type('image/png').send(fs.createReadStream(file)) : reply.code(404).send({ error: 'Not found' });
  });

  app.get<{ Params: { id: string } }>('/renders/:id.png', {
    schema: { params: { type: 'object', properties: { id: { type: 'string', pattern: '^[a-f0-9]{20}$' } } } },
  }, async (req, reply) => {
    const file = renderPath(req.params.id);
    return fs.existsSync(file) ? reply.type('image/png').send(fs.createReadStream(file)) : reply.code(404).send({ error: 'Render not found or already cleaned up' });
  });

  // Claude copywriting. Nothing here posts or queues anything.
  const text = { type: 'string', maxLength: 2000 };
  app.post<{ Body: prompts.CopyInput }>('/copy', {
    schema: { body: { type: 'object', required: ['template'], additionalProperties: false,
      properties: { template: name, size, topic: text, url: { type: 'string', maxLength: 2000 }, keyword: text, audience: text, sources: { type: 'string', maxLength: 20000 } } } },
  }, async req => prompts.writeCopy(req.body));

  // Template work can keep Claude busy for minutes, longer than a proxy will hold a request open.
  // These answer 202 with a job id at once; GET /jobs/<id> gives the result when it is ready.
  const jobs = new Map<string, { done: boolean; result?: unknown; error?: { statusCode: number; message: string } }>();
  const background = (reply: FastifyReply, work: () => Promise<unknown>) => {
    const id = crypto.randomUUID();
    const job: { done: boolean; result?: unknown; error?: { statusCode: number; message: string } } = { done: false };
    jobs.set(id, job);
    work().then(r => { job.result = r; }, (err: any) => { job.error = { statusCode: err.statusCode ?? 500, message: err.message }; })
      .finally(() => { job.done = true; setTimeout(() => jobs.delete(id), 30 * 60_000).unref(); });
    return reply.code(202).send({ job: id });
  };
  app.get<{ Params: { id: string } }>('/jobs/:id', async (req, reply) => {
    const job = jobs.get(req.params.id) ?? fail(404, 'That job has finished and expired, or never existed');
    if (!job.done) return { done: false };
    if (job.error) return reply.code(job.error.statusCode).send({ error: job.error.message, message: job.error.message, statusCode: job.error.statusCode });
    return { done: true, result: job.result };
  });

  app.post<{ Body: { template: string; change: string; fields: Fields; size?: string } }>('/templates/tweak', {
    schema: { body: { type: 'object', required: ['template', 'change', 'fields'], additionalProperties: false,
      properties: { template: name, change: { type: 'string', minLength: 3, maxLength: 2000 }, fields, size } } },
  }, async (req, reply) => background(reply, () => prompts.tweakTemplate(req.body)));

  app.post<{ Body: { description: string; base: string } }>('/templates/design', {
    schema: { body: { type: 'object', required: ['description', 'base'], additionalProperties: false,
      properties: { description: { type: 'string', minLength: 3, maxLength: 4000 }, base: name } } },
  }, async (req, reply) => background(reply, () => prompts.designTemplate(req.body)));

  app.get('/prompts', async () => prompts.list());
  app.get<{ Params: { name: string } }>('/prompts/:name', { schema: { params: nameParams } }, async req => {
    const p = prompts.current(req.params.name);
    return { name: req.params.name, version: p.id, body: p.body, vars: prompts.varsOf(p.body) };
  });
  app.put<{ Params: { name: string }; Body: { body: string; note?: string } }>('/prompts/:name', {
    schema: { params: nameParams, body: { type: 'object', required: ['body'], properties: { body: { type: 'string', maxLength: 60000 }, note: { type: 'string', maxLength: 200 } } } },
  }, async req => ({ version: prompts.save(req.params.name, req.body.body, req.body.note) }));
  app.get<{ Params: { name: string } }>('/prompts/:name/versions', { schema: { params: nameParams } }, async req => prompts.versions(req.params.name));
  app.post<{ Params: { name: string; version: number } }>('/prompts/:name/rollback/:version', {
    schema: { params: { type: 'object', properties: { name, version: { type: 'integer' } } } },
  }, async req => ({ version: prompts.rollback(req.params.name, req.params.version) }));

  // Test run: shows what a prompt (saved or not) writes, without posting or queueing anything.
  app.post<{ Params: { name: string }; Body: { vars: Fields; body?: string; template?: string } }>('/prompts/:name/test', {
    schema: { params: nameParams, body: { type: 'object', required: ['vars'],
      properties: { vars: { type: 'object', additionalProperties: { type: 'string', maxLength: 20000 } }, body: { type: 'string', maxLength: 60000 }, template: name } } },
  }, async req => {
    const vars = { ...req.body.vars, ...(req.body.template ? prompts.templateVars(req.body.template) : {}) };
    const run = await prompts.runPrompt(req.params.name, vars, { body: req.body.body });
    return { output: run.output, cost_gbp: run.cost_gbp };
  });

  // Buffer posting. Nothing goes to Buffer until a post is approved (or AUTO_POST is on).
  app.get('/buffer/channels', async () => buffer.channels());

  const postId = { type: 'object', properties: { id: { type: 'integer' } } };
  app.post<{ Body: posts.PostInput }>('/posts', {
    schema: { body: { type: 'object', required: ['render_id', 'channels', 'text', 'mode'], additionalProperties: false, properties: {
      render_id: { type: 'string', pattern: '^[a-f0-9]{20}$' },
      channels: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 100 }, name: { type: 'string', maxLength: 200 } } } },
      text: { type: 'string', minLength: 1, maxLength: 5000 },
      mode: { enum: ['queue', 'scheduled', 'draft'] },
      due_at: { type: 'string', format: 'date-time' },
      idempotency_key: { type: 'string', maxLength: 100 },
    } } },
  }, async req => posts.create(req.body));
  app.get<{ Querystring: { status?: string } }>('/posts', async req => posts.list(req.query.status));
  app.post<{ Params: { id: number } }>('/posts/:id/approve', { schema: { params: postId } }, async req => posts.approve(req.params.id));
  app.post<{ Params: { id: number } }>('/posts/:id/reject', { schema: { params: postId } }, async req => posts.reject(req.params.id));
  app.post<{ Params: { id: number } }>('/posts/:id/mark-sent', { schema: { params: postId } }, async req => posts.markSent(req.params.id));

  // Articles: draft with Claude, check, approve, publish as static files, then social posts.
  const articleId = { type: 'object', properties: { id: { type: 'integer' } } };
  const category = { type: 'string', maxLength: 100 };
  app.post<{ Body: articles.DraftInput }>('/articles', {
    schema: { body: { type: 'object', required: ['topic'], additionalProperties: false, properties: {
      topic: { type: 'string', minLength: 3, maxLength: 2000 }, keyword: text, audience: text, url: text, category,
      sources: { type: 'string', maxLength: 40000 } } } },
  }, async req => articles.draft(req.body));
  app.get('/articles', async () => articles.list());
  app.get('/articles/categories', async () => articles.categories());
  app.get('/articles/live', async () => articles.live());
  app.post<{ Body: { category: string; focus?: string; audience?: string } }>('/articles/research', { schema: { body: { type: 'object', additionalProperties: false, required: ['category'],
    properties: { category: { type: 'string', maxLength: 100 }, focus: { type: 'string', maxLength: 1000 }, audience: { type: 'string', maxLength: 200 } } } } },
    async req => articles.research(req.body.category, req.body));
  app.post<{ Body: { category: string; topic: string; keyword?: string; audience?: string } }>('/articles/sources', { schema: { body: { type: 'object', additionalProperties: false, required: ['category', 'topic'],
    properties: { category: { type: 'string', maxLength: 100 }, topic: { type: 'string', minLength: 3, maxLength: 1000 }, keyword: { type: 'string', maxLength: 200 }, audience: { type: 'string', maxLength: 200 } } } } },
    async req => articles.findSources(req.body.category, req.body));
  app.get<{ Querystring: { category: string } }>('/articles/in-category', { schema: { querystring: { type: 'object', required: ['category'], properties: { category: { type: 'string', maxLength: 100 } } } } },
    async req => articles.inCategory(req.query.category));
  app.post<{ Body: { category: string; slug: string } }>('/articles/import', { schema: { body: { type: 'object', additionalProperties: false, required: ['category', 'slug'],
    properties: { category: { type: 'string', maxLength: 100 }, slug: { type: 'string', maxLength: 120 } } } } }, async req => articles.importPage(req.body.category, req.body.slug));
  app.get<{ Params: { id: number } }>('/articles/:id', { schema: { params: articleId } }, async req => articles.show(req.params.id));
  app.put<{ Params: { id: number }; Body: Parameters<typeof articles.update>[1] }>('/articles/:id', {
    schema: { params: articleId, body: { type: 'object', additionalProperties: false, properties: {
      title: { type: 'string', minLength: 3, maxLength: 200 }, summary: { type: 'string', maxLength: 400 }, slug: { type: 'string', maxLength: 80 },
      category, body: { type: 'string', minLength: 1, maxLength: 60000 }, sources: { type: 'string', maxLength: 40000 } } } },
  }, async req => articles.update(req.params.id, req.body));
  for (const act of ['approve', 'reject', 'reopen', 'publish'] as const)
    app.post<{ Params: { id: number } }>(`/articles/:id/${act}`, { schema: { params: articleId } }, async req => articles[act](req.params.id));
  app.get<{ Params: { id: number }; Querystring: { format: 'md' | 'html' } }>('/articles/:id/download', {
    schema: { params: articleId, querystring: { type: 'object', required: ['format'], properties: { format: { enum: ['md', 'html'] } } } },
  }, async (req, reply) => {
    const a = articles.show(req.params.id);
    return reply.type(req.query.format === 'md' ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8')
      .header('content-disposition', `attachment; filename="${a.slug}.${req.query.format}"`).send(articles.download(a.id, req.query.format));
  });
  app.post<{ Params: { id: number }; Body: Parameters<typeof articles.social>[1] }>('/articles/:id/social', {
    schema: { params: articleId, body: { type: 'object', required: ['template', 'channels', 'mode'], additionalProperties: false, properties: {
      template: name, mode: { enum: ['queue', 'scheduled', 'draft'] }, due_at: { type: 'string', format: 'date-time' },
      channels: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 100 }, name: { type: 'string', maxLength: 200 } } } },
    } } },
  }, async req => articles.social(req.params.id, req.body));

  // Sales
  const id = { type: 'object', properties: { id: { type: 'integer', minimum: 1 } } };
  const campaignBody = { type: 'object', additionalProperties: false, required: ['name', 'industries', 'towns', 'lead_type', 'max_leads', 'sources'], properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 }, industries: { type: 'string', minLength: 1, maxLength: 1000 }, towns: { type: 'string', minLength: 1, maxLength: 1000 },
    lead_type: { enum: leads.LEAD_TYPES }, max_leads: { type: 'integer', minimum: 1, maximum: 100 },
    sources: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: leads.SOURCES } } } };
  app.get('/campaigns', async () => leads.campaigns());
  app.get('/campaigns/usage', async () => leads.usage());
  app.get<{ Querystring: { q: string } }>('/campaigns/towns', { schema: { querystring: { type: 'object', required: ['q'], properties: { q: { type: 'string', maxLength: 60 } } } } },
    async req => leads.towns(req.query.q));
  app.post<{ Body: leads.CampaignInput }>('/campaigns', { schema: { body: campaignBody } }, async (req, reply) => reply.code(201).send(leads.createCampaign(req.body)));
  app.get<{ Params: { id: number } }>('/campaigns/:id', { schema: { params: id } }, async req => leads.campaign(req.params.id));
  app.put<{ Params: { id: number }; Body: leads.CampaignInput }>('/campaigns/:id', { schema: { params: id, body: campaignBody } }, async req => leads.updateCampaign(req.params.id, req.body));
  app.delete<{ Params: { id: number } }>('/campaigns/:id', { schema: { params: id } }, async req => leads.deleteCampaign(req.params.id));
  app.post<{ Params: { id: number }; Querystring: { all?: boolean } }>('/campaigns/:id/analyse', { schema: { params: id, querystring: { type: 'object', properties: { all: { type: 'boolean' } } } } },
    async (req, reply) => { leads.campaign(req.params.id); return reply.code(202).send(analyseCampaign(req.params.id, req.query.all)); });
  app.post<{ Params: { id: number } }>('/leads/:id/analyse', { schema: { params: id } }, async req => analyseLead(req.params.id));
  app.get<{ Params: { id: number } }>('/leads/:id/screenshot.jpg', { schema: { params: id } }, async (req, reply) => {
    const file = leads.screenshotPath(req.params.id);
    if (!fs.existsSync(file)) return reply.code(404).send({ error: 'No screenshot for this lead' });
    return reply.type('image/jpeg').header('cache-control', 'no-cache').send(fs.createReadStream(file));
  });
  app.post<{ Params: { id: number } }>('/campaigns/:id/run', { schema: { params: id } }, async (req, reply) => reply.code(202).send(leads.run(req.params.id)));

  const yesNo = { enum: ['yes', 'no'] };
  app.get<{ Querystring: Omit<leads.LeadFilter, 'search'> & { q?: string } }>('/leads', { schema: { querystring: { type: 'object', properties: {
    campaign: { type: 'integer' }, status: { enum: [...leads.STATUSES, 'active', 'contacted_plus'] }, priority: { enum: ['hot', 'warm', 'cold'] },
    q: { type: 'string', maxLength: 100 }, has_website: yesNo, has_email: yesNo, has_phone: yesNo, sort: { enum: leads.LEAD_SORTS } } } } },
  async req => leads.leads({ ...req.query, search: req.query.q }));
  app.get<{ Params: { id: number } }>('/leads/:id', { schema: { params: id } }, async req => leads.lead(req.params.id));
  const str = (max: number) => ({ type: 'string', maxLength: max });
  app.put<{ Params: { id: number }; Body: leads.LeadChange }>('/leads/:id', { schema: { params: id, body: { type: 'object', additionalProperties: false, properties: {
    company_name: { type: 'string', minLength: 1, maxLength: 200 }, contact_name: str(200), phone: str(40), email: str(200), website_url: str(500),
    status: { enum: leads.STATUSES }, follow_up_date: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] } } } } },
  async req => leads.updateLead(req.params.id, req.body));
  app.post<{ Params: { id: number }; Body: { text: string } }>('/leads/:id/notes', { schema: { params: id, body: { type: 'object', required: ['text'],
    additionalProperties: false, properties: { text: { type: 'string', minLength: 1, maxLength: 5000 } } } } }, async req => leads.addNote(req.params.id, req.body.text));

  // Outreach
  app.post<{ Params: { id: number } }>('/leads/:id/email', { schema: { params: id } }, async (req, reply) => background(reply, () => outreach.draft(req.params.id)));
  app.post<{ Params: { id: number } }>('/leads/:id/company-check', { schema: { params: id } }, async req => outreach.companyCheck(req.params.id));
  app.get('/emails', async () => ({ emails: outreach.list(), sent_today: outreach.sentToday(), daily_cap: OUTREACH_DAILY_CAP, inbox: IMAP_HOST ? inboxState() : null }));
  app.put<{ Params: { id: number }; Body: { subject?: string; body?: string } }>('/emails/:id', { schema: { params: id, body: { type: 'object', additionalProperties: false,
    properties: { subject: { type: 'string', minLength: 1, maxLength: 200 }, body: { type: 'string', minLength: 1, maxLength: 10000 } } } } },
  async req => outreach.edit(req.params.id, req.body));
  for (const act of ['approve', 'reject', 'test'] as const)
    app.post<{ Params: { id: number } }>(`/emails/:id/${act}`, { schema: { params: id } }, async req => outreach[act](req.params.id));
  app.post<{ Params: { id: number } }>('/emails/:id/mark-sent', { schema: { params: id } }, async req => outreach.markSent(req.params.id));
  app.get('/suppression', async () => outreach.suppressionList());
  app.post<{ Body: { emails: string[] } }>('/suppression', { schema: { body: { type: 'object', required: ['emails'], additionalProperties: false,
    properties: { emails: { type: 'array', maxItems: 20000, items: { type: 'string', maxLength: 200 } } } } } }, async req => outreach.suppress(req.body.emails, 'added by hand'));
  app.delete<{ Querystring: { email: string } }>('/suppression', { schema: { querystring: { type: 'object', required: ['email'], properties: { email: { type: 'string', maxLength: 200 } } } } },
    async req => outreach.unsuppress(req.query.email));

  // The unsubscribe link in every email. Opening it only asks; the button (or a mail app's one click unsubscribe) does it,
  // so a link scanner that opens every link cannot unsubscribe anyone.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, body));
  const page = (reply: FastifyReply, text: string, form = '') => reply.type('text/html; charset=utf-8').send(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Red Cherry IT</title>
<body style="font:17px/1.5 system-ui,sans-serif;color:#1a1a1a;max-width:480px;margin:15vh auto;padding:0 20px">
<p style="color:#b5333f;font-weight:800">Red Cherry IT</p><p>${text}</p>${form}</body>`);
  const unsub = { querystring: { type: 'object', required: ['e', 't'], properties: { e: { type: 'string', maxLength: 200 }, t: { type: 'string', maxLength: 64 } } } };
  const bad = 'That link is not complete. Reply to the email with "unsubscribe" and we will take you off our list.';
  app.get<{ Querystring: { e: string; t: string } }>('/unsubscribe', { schema: unsub }, async (req, reply) => !outreach.validLink(req.query.e, req.query.t) ? page(reply.code(400), bad) : page(reply,
    `Stop emails from Red Cherry IT to ${esc(req.query.e)}?`,
    `<form method="post"><button style="font:inherit;padding:10px 18px;border:0;border-radius:8px;background:#b5333f;color:#fff;cursor:pointer">Unsubscribe</button></form>`));
  app.post<{ Querystring: { e: string; t: string } }>('/unsubscribe', { schema: unsub }, async (req, reply) => {
    if (!outreach.validLink(req.query.e, req.query.t)) return page(reply.code(400), bad);
    outreach.unsubscribe(req.query.e, req.query.t);
    return page(reply, `Done. ${esc(req.query.e)} will not get any more emails from us.`);
  });

  app.get('/usage', async () => ({
    month_spend_gbp: monthSpendGbp(),
    cap_gbp: CLAUDE_MONTHLY_CAP_GBP,
    recent: db.prepare('SELECT job, model, input_tokens, output_tokens, cost_usd, created_at FROM claude_usage ORDER BY id DESC LIMIT 20').all(),
  }));

  return app;
}

export async function start() {
  if (!API_KEY) {
    console.error('API_KEY is not set. Copy .env.example to .env and set it.');
    process.exit(1);
  }
  seed();
  prompts.seed();
  startCleanup();
  outreach.startOutreach();
  startInbox();
  const app = buildApp();
  const stop = async () => { await app.close(); await closeBrowser(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await app.listen({ port: PORT, host: HOST });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await start();
