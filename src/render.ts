// One Chromium for every job, one render at a time.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { db } from './db.ts';
import { fail, RENDERS_DIR, ROOT } from './config.ts';
import { current, fill, type Problem } from './templates.ts';
import { checkUrl } from './page.ts';

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

export const renderPath = (id: string, ext: 'png' | 'mp4' = 'png') => path.join(RENDERS_DIR, `${id}.${ext}`);

let browser: Browser | undefined;
async function getBrowser() {
  if (!browser?.isConnected()) {
    browser = await chromium.launch();
    browser.on('disconnected', () => { browser = undefined; });
  }
  return browser;
}
export const closeBrowser = () => browser?.close();

// Opens the page, runs `work` and closes it. The viewport fits upright posts and 1200 wide article headers.
async function withPage<T>(html: string, work: (page: Page) => Promise<T>): Promise<T> {
  const page = await (await getBrowser()).newPage({ viewport: { width: 1200, height: 1920 } });
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
    return await work(page);
  } finally {
    await page.close().catch(() => {});
  }
}

const layoutErrors = (page: Page): Promise<Problem[]> => page.evaluate(() => (window as any).layoutErrors());

// Runs the layout check. Saves a screenshot only when `file` is given and everything fits.
// A motion template is shot at its last frame, so the still matches the end of the clip.
const shoot = (html: string, file?: string) => withPage(html, async page => {
  const problems = await layoutErrors(page);
  if (file && !problems.length) {
    await page.evaluate(() => document.getAnimations().forEach(a => { if (isFinite(a.effect!.getComputedTiming().endTime as number)) a.finish(); }));
    await page.locator('.post').screenshot({ path: file });
  }
  return problems;
});

const FPS = 30;

// Plays a motion template frame by frame and pipes the frames to ffmpeg. Nothing runs in real time,
// so a slow server makes a slow render, never a jerky clip.
const film = (html: string, file: string) => withPage(html, async page => {
  const problems = await layoutErrors(page);
  if (problems.length) return problems;
  const seconds = await page.evaluate(() => Number((document.querySelector('.post') as HTMLElement).dataset.seconds));
  if (!(seconds > 0 && seconds <= 30)) fail(400, 'This template is not a motion template');
  const clip = (await page.locator('.post').boundingBox())!;
  await page.evaluate(() => document.getAnimations().forEach(a => a.pause()));

  const tmp = `${file}.part`;
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-f', 'mp4', tmp], { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  ff.stderr.on('data', d => { stderr += d; });
  const done = new Promise<void>((resolve, reject) => {
    ff.on('error', err => reject(new Error(`Could not run ffmpeg: ${err.message}`)));
    ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${stderr.trim().slice(-500)}`)));
  });
  done.catch(() => {}); // awaited below; this only stops an early failure counting as unhandled
  ff.stdin.on('error', () => {}); // ffmpeg quit early: `done` carries its message
  try {
    for (let i = 0; i < seconds * FPS; i++) {
      await page.evaluate(t => document.getAnimations().forEach(a => { a.currentTime = t; }), i * 1000 / FPS);
      const frame = await page.screenshot({ clip, type: 'jpeg', quality: 92 });
      if (!ff.stdin.write(frame)) await Promise.race([new Promise(r => ff.stdin.once('drain', r)), done]);
    }
    ff.stdin.end();
    await done;
    fs.renameSync(tmp, file);
  } catch (err) {
    ff.kill();
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return [];
});

export type RenderResult = { ok: true; id: string; file: string } | { ok: false; problems: Problem[] };

// `html` is a one off version of the template for a single post; the saved template is not touched.
async function renderNow(template: string, fields: Record<string, string>, ext: 'png' | 'mp4', size?: string, html?: string): Promise<RenderResult> {
  const tpl = current(template);
  const body = html ?? tpl.body;
  const key = [...(ext === 'png' ? [] : [ext]), template, body, fields, ...(size ? [size] : [])];
  const id = crypto.createHash('sha256').update(JSON.stringify(key)).digest('hex').slice(0, 20);
  const file = renderPath(id, ext);
  // Same template and text as an earlier render: hand back that file, never render twice.
  if (fs.existsSync(file)) return { ok: true, id, file };

  const filled = fill(body, fields, size);
  if (filled.problems.length) return { ok: false, problems: filled.problems };

  const problems = ext === 'png' ? await shootWithRetry(filled.html, file) : await film(filled.html, file);
  if (problems.length) return { ok: false, problems };

  db.prepare(`INSERT INTO renders (id, template, template_version, fields) VALUES (?, ?, ?, ?)
              ON CONFLICT (id) DO UPDATE SET created_at = datetime('now'), posted_at = NULL, deleted_at = NULL`)
    .run(id, template, tpl.id, JSON.stringify(fields));
  return { ok: true, id, file };
}

async function shootWithRetry(html: string, file?: string) {
  try {
    return await shoot(html, file);
  } catch (err) {
    if (browser?.isConnected()) throw err;
    return shoot(html, file); // browser crashed: one retry on a fresh one
  }
}

let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const job = queue.then(work);
  queue = job.catch(() => {});
  return job;
}

// A lead's homepage as a JPEG, in its own context so nothing it sets touches the renders. Every request the page makes is
// checked like a page link, so a site can never make this server load something on its own network.
export const screenshotSite = (url: string, file: string) => enqueue(async () => {
  const context = await (await getBrowser()).newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const ok = new Map<string, Promise<boolean>>();
  try {
    await context.route('**/*', route => {
      const u = new URL(route.request().url());
      if (u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
      if (!ok.has(u.host)) ok.set(u.host, checkUrl(u.href).then(() => true, () => false));
      return ok.get(u.host)!.then(allowed => allowed ? route.continue() : route.abort());
    });
    const page = await context.newPage();
    // A slow page is still shot as far as it got; one that never started loading is an error, not a blank picture.
    const failed = await page.goto(url, { waitUntil: 'load', timeout: 30_000 }).then(() => null, (err: Error) => err);
    if (failed && page.url() === 'about:blank') throw new Error(failed.message.split('\n')[0].replace(/^page\.goto: /, ''));
    await page.waitForTimeout(1500); // cookie banners and fade ins
    await page.screenshot({ path: file, type: 'jpeg', quality: 70 });
  } finally {
    await context.close().catch(() => {});
  }
});

export const render = (template: string, fields: Record<string, string>, size?: string, html?: string) => enqueue(() => renderNow(template, fields, 'png', size, html));
export const renderVideo = (template: string, fields: Record<string, string>, size?: string, html?: string) => enqueue(() => renderNow(template, fields, 'mp4', size, html));

// Does this text fit the template? Same check as a render, without saving an image.
export const checkFit = (template: string, fields: Record<string, string>, size?: string) => checkHtml(current(template).body, fields, size);

// The same check for template HTML that is not saved yet.
export const checkHtml = (html: string, fields: Record<string, string>, size?: string) => enqueue(async () => {
  const filled = fill(html, fields, size);
  return filled.problems.length ? filled.problems : shootWithRetry(filled.html);
});
