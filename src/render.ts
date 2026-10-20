// One Chromium for every job, one render at a time.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { db } from './db.ts';
import { RENDERS_DIR, ROOT } from './config.ts';
import { current, fill, type Problem } from './templates.ts';

const TYPES: Record<string, string> = {
  '.js': 'text/javascript', '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
};

// Files a template may load: /check.js, /fonts/<file>, /assets/<file>. Shared with the HTTP server.
export function publicFile(urlPath: string) {
  const m = urlPath.match(/^\/(fonts|assets)\/([\w-][\w.-]*)$/);
  const file = urlPath === '/check.js' ? path.join(ROOT, 'public', 'check.js') : m ? path.join(ROOT, m[1], m[2]) : undefined;
  if (!file || !fs.existsSync(file)) return undefined;
  return { file, type: TYPES[path.extname(file)] ?? 'application/octet-stream' };
}

export const renderPath = (id: string) => path.join(RENDERS_DIR, `${id}.png`);

let browser: Browser | undefined;
async function getBrowser() {
  if (!browser?.isConnected()) {
    browser = await chromium.launch();
    browser.on('disconnected', () => { browser = undefined; });
  }
  return browser;
}
export const closeBrowser = () => browser?.close();

async function shoot(html: string, file: string): Promise<Problem[]> {
  const page = await (await getBrowser()).newPage({ viewport: { width: 1080, height: 1080 } });
  try {
    // No network at all: the page gets its HTML and local files only, so renders are repeatable.
    await page.route('**/*', route => route.abort());
    await page.route('http://render.local/**', route => {
      const p = new URL(route.request().url()).pathname;
      if (p === '/') return route.fulfill({ body: html, contentType: 'text/html; charset=utf-8' });
      const f = publicFile(p);
      return f ? route.fulfill({ path: f.file, contentType: f.type }) : route.fulfill({ status: 404 });
    });
    await page.goto('http://render.local/');
    const problems: Problem[] = await page.evaluate(() => (window as any).layoutErrors());
    if (!problems.length) await page.locator('.post').screenshot({ path: file });
    return problems;
  } finally {
    await page.close().catch(() => {});
  }
}

export type RenderResult = { ok: true; id: string; file: string } | { ok: false; problems: Problem[] };

async function renderNow(template: string, fields: Record<string, string>): Promise<RenderResult> {
  const tpl = current(template);
  const id = crypto.createHash('sha256').update(JSON.stringify([template, tpl.html, fields])).digest('hex').slice(0, 20);
  const file = renderPath(id);
  // Same template and text as an earlier render: hand back that file, never render twice.
  if (fs.existsSync(file)) return { ok: true, id, file };

  const filled = fill(tpl.html, fields);
  if (filled.problems.length) return { ok: false, problems: filled.problems };

  let problems: Problem[];
  try {
    problems = await shoot(filled.html, file);
  } catch (err) {
    if (browser?.isConnected()) throw err;
    problems = await shoot(filled.html, file); // browser crashed: one retry on a fresh one
  }
  if (problems.length) return { ok: false, problems };

  db.prepare(`INSERT INTO renders (id, template, template_version, fields) VALUES (?, ?, ?, ?)
              ON CONFLICT (id) DO UPDATE SET created_at = datetime('now'), posted_at = NULL, deleted_at = NULL`)
    .run(id, template, tpl.id, JSON.stringify(fields));
  return { ok: true, id, file };
}

let queue: Promise<unknown> = Promise.resolve();
export function render(template: string, fields: Record<string, string>): Promise<RenderResult> {
  const job = queue.then(() => renderNow(template, fields));
  queue = job.catch(() => {});
  return job;
}
