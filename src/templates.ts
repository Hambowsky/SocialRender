// Templates live in SQLite as versions. The newest version of a name is the live one.
// The files in templates/ are seeds, loaded into the database on start.
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.ts';
import { fail, MAX_FIELD_CHARS, ROOT, TEMPLATE_VERSIONS_KEEP } from './config.ts';

export type Problem = { field: string | null; message: string; overflow_px?: number; shorten_by_chars?: number };
type Row = { id: number; html: string };

export const NAME_PATTERN = '^[a-z0-9-]{1,40}$';

export function current(name: string): Row {
  const row = db.prepare('SELECT id, html FROM template_versions WHERE template = ? ORDER BY id DESC LIMIT 1').get(name) as Row | undefined;
  return row ?? fail(404, `There is no template called ${name}`);
}

export function list() {
  return db.prepare(`SELECT template AS name, MAX(id) AS version, MAX(created_at) AS updated_at
                     FROM template_versions GROUP BY template ORDER BY template`).all();
}

export function versions(name: string) {
  current(name);
  return db.prepare('SELECT id, note, created_at FROM template_versions WHERE template = ? ORDER BY id DESC').all(name);
}

export function save(name: string, html: string, note = ''): number {
  if (!new RegExp(NAME_PATTERN).test(name)) fail(400, 'Template names use lowercase letters, numbers and hyphens only');
  if (!/class="post"/.test(html)) fail(400, 'A template needs an element with class="post"');
  const { lastInsertRowid } = db.prepare('INSERT INTO template_versions (template, html, note) VALUES (?, ?, ?)').run(name, html, note);
  db.prepare(`DELETE FROM template_versions WHERE template = ? AND id NOT IN
              (SELECT id FROM template_versions WHERE template = ? ORDER BY id DESC LIMIT ?)`).run(name, name, TEMPLATE_VERSIONS_KEEP);
  return Number(lastInsertRowid);
}

export function rollback(name: string, id: number): number {
  const row = db.prepare('SELECT html FROM template_versions WHERE template = ? AND id = ?').get(name, id) as Row | undefined;
  if (!row) fail(404, `Version ${id} of ${name} no longer exists`);
  return save(name, row!.html, `Rolled back to version ${id}`);
}

// A seed file is added as a new version only when its exact HTML is not already in the history,
// so edits made in the editor survive restarts. Changing a seed file in the repo does replace them
// (they stay in the history for rollback).
export function seed() {
  const dir = path.join(ROOT, 'templates');
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.html'))) {
    const name = file.slice(0, -5);
    const html = fs.readFileSync(path.join(dir, file), 'utf8');
    if (!db.prepare('SELECT 1 FROM template_versions WHERE template = ? AND html = ?').get(name, html)) save(name, html, 'Loaded from templates folder');
  }
}

// Fields a caller must send, in template order. highlight_word goes with headline.
export function fieldsOf(html: string): string[] {
  const names = [...new Set([...html.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]))];
  const i = names.indexOf('headline');
  if (i >= 0) names.splice(i + 1, 0, 'highlight_word');
  return names;
}

export function sampleOf(html: string): Record<string, string> {
  const m = html.match(/<script type="application\/json" id="sample">([\s\S]*?)<\/script>/);
  return m ? JSON.parse(m[1]) : {};
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Text only: every value is escaped, so a caller can never change the design.
export function fill(html: string, fields: Record<string, string>): { html: string; problems: Problem[] } {
  const problems: Problem[] = [];
  let out = html.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = String(fields[key] ?? '').trim();
    if (!value) { problems.push({ field: key, message: `${key} is required` }); return ''; }
    if (value.length > MAX_FIELD_CHARS) problems.push({ field: key, message: `${key} is over ${MAX_FIELD_CHARS} characters` });
    if (key !== 'headline') return esc(value);

    let headline = esc(value).replace(/\r?\n/g, '<br>');
    const word = String(fields.highlight_word ?? '').trim();
    if (word) {
      const re = new RegExp(`(?<![\\w])(${escRe(esc(word))})(?![\\w])`, 'i');
      if (re.test(headline)) headline = headline.replace(re, '<span class="hl">$1</span>');
      else problems.push({ field: 'highlight_word', message: `highlight_word "${word}" is not in the headline` });
    }
    return headline;
  });
  const inject = `<script>window.fillProblems = ${JSON.stringify(problems).replace(/</g, '\\u003c')}</script>\n<script src="/check.js"></script>\n</head>`;
  out = out.replace('</head>', inject);
  return { html: out, problems };
}
