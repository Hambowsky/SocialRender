// Versioned text stored in SQLite, used for templates and prompts.
// The newest version of a name is the live one. Files in the seed folder are loaded on start.
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.ts';
import { fail, TEMPLATE_VERSIONS_KEEP } from './config.ts';

type Row = { id: number; body: string };

export const NAME_PATTERN = '^[a-z0-9-]{1,40}$';

export function versionStore(table: 'template_versions' | 'prompt_versions', label: string, validate: (body: string) => void) {
  function current(name: string): Row {
    const row = db.prepare(`SELECT id, body FROM ${table} WHERE name = ? ORDER BY id DESC LIMIT 1`).get(name) as Row | undefined;
    return row ?? fail(404, `There is no ${label} called ${name}`);
  }

  function list() {
    return db.prepare(`SELECT name, MAX(id) AS version, MAX(created_at) AS updated_at FROM ${table} GROUP BY name ORDER BY name`).all();
  }

  function versions(name: string) {
    current(name);
    return db.prepare(`SELECT id, note, created_at FROM ${table} WHERE name = ? ORDER BY id DESC`).all(name);
  }

  function save(name: string, body: string, note = ''): number {
    if (!new RegExp(NAME_PATTERN).test(name)) fail(400, `${label} names use lowercase letters, numbers and hyphens only`);
    validate(body);
    const { lastInsertRowid } = db.prepare(`INSERT INTO ${table} (name, body, note) VALUES (?, ?, ?)`).run(name, body, note);
    db.prepare(`DELETE FROM ${table} WHERE name = ? AND id NOT IN
                (SELECT id FROM ${table} WHERE name = ? ORDER BY id DESC LIMIT ?)`).run(name, name, TEMPLATE_VERSIONS_KEEP);
    return Number(lastInsertRowid);
  }

  function rollback(name: string, id: number): number {
    const row = db.prepare(`SELECT body FROM ${table} WHERE name = ? AND id = ?`).get(name, id) as Row | undefined;
    if (!row) fail(404, `Version ${id} of ${name} no longer exists`);
    return save(name, row!.body, `Rolled back to version ${id}`);
  }

  // A seed file is added as a new version only when its exact text is not already in the history,
  // so edits made in the editor survive restarts. Changing a seed file in the repo does replace them
  // (they stay in the history for rollback).
  function seed(dir: string, ext: string) {
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith(ext))) {
      const name = file.slice(0, -ext.length);
      const body = fs.readFileSync(path.join(dir, file), 'utf8');
      if (!db.prepare(`SELECT 1 FROM ${table} WHERE name = ? AND body = ?`).get(name, body)) save(name, body, `Loaded from ${path.basename(dir)} folder`);
    }
  }

  return { current, list, versions, save, rollback, seed };
}
