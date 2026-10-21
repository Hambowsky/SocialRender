import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { API_KEY, CLAUDE_MONTHLY_CAP_GBP, HOST, MAX_FIELD_CHARS, PORT, RENDERS_PER_MIN, ROOT } from './config.ts';
import { db } from './db.ts';
import { closeBrowser, publicFile, render, renderPath } from './render.ts';
import { current, fieldsOf, fill, list, rollback, sampleOf, save, seed, versions } from './templates.ts';
import { NAME_PATTERN } from './versions.ts';
import * as prompts from './copy.ts';
import { monthSpendGbp } from './claude.ts';
import { startCleanup } from './cleanup.ts';
import * as buffer from './buffer.ts';
import * as posts from './posts.ts';
import * as articles from './articles.ts';

type Fields = Record<string, string>;
const name = { type: 'string', pattern: NAME_PATTERN };
const fields = { type: 'object', maxProperties: 20, additionalProperties: { type: 'string', maxLength: MAX_FIELD_CHARS } };
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
    if (p === '/health' || p === '/' || publicFile(p) || p.startsWith('/public/renders/')) return;
    if (!keyMatches(req.headers['x-api-key'])) return reply.code(401).send({ error: 'Missing or wrong API key' });
    const group = p === '/render' ? 'render' : p === '/copy' || p === '/templates/design' || p === '/articles' && req.method === 'POST' || p.endsWith('/social') || p.endsWith('/test') || p.endsWith('/research') ? 'claude' : 'other';
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
    return { name: req.params.name, version: t.id, html: t.body, fields: fieldsOf(t.body), sample: sampleOf(t.body) };
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
  app.post<{ Body: { template: string; fields: Fields; html?: string } }>('/preview', {
    schema: { body: { type: 'object', required: ['template', 'fields'], properties: { template: name, fields, html: { type: 'string', maxLength: 60000 } } } },
  }, async (req, reply) => {
    const html = req.body.html ?? current(req.body.template).body;
    return reply.type('text/html; charset=utf-8').send(fill(html, req.body.fields).html);
  });

  app.post<{ Body: { template: string; fields: Fields }; Querystring: { format?: string } }>('/render', {
    schema: {
      body: { type: 'object', required: ['template', 'fields'], properties: { template: name, fields } },
      querystring: { type: 'object', properties: { format: { enum: ['png', 'json'] } } },
    },
  }, async (req, reply) => {
    const result = await render(req.body.template, req.body.fields);
    if (!result.ok) return reply.code(422).send({ error: 'The text does not fit this template', problems: result.problems });
    if (req.query.format === 'json') return { id: result.id, url: `/renders/${result.id}.png`, width: 1080, height: 1080 };
    return reply.type('image/png').header('x-render-id', result.id)
      .header('content-disposition', `inline; filename="${req.body.template}-${result.id}.png"`)
      .send(fs.createReadStream(result.file));
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
      properties: { template: name, topic: text, url: { type: 'string', maxLength: 2000 }, keyword: text, audience: text, sources: { type: 'string', maxLength: 20000 } } } },
  }, async req => prompts.writeCopy(req.body));

  app.post<{ Body: { description: string; base: string } }>('/templates/design', {
    schema: { body: { type: 'object', required: ['description', 'base'], additionalProperties: false,
      properties: { description: { type: 'string', minLength: 3, maxLength: 4000 }, base: name } } },
  }, async req => prompts.designTemplate(req.body));

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
  const app = buildApp();
  const stop = async () => { await app.close(); await closeBrowser(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await app.listen({ port: PORT, host: HOST });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await start();
