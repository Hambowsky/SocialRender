import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, RENDERS_DIR } from './config.ts';

fs.mkdirSync(RENDERS_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

// Append only: each entry runs once, in order, tracked by PRAGMA user_version.
// Later phases add their tables here (see PLAN.md for the planned shapes).
const migrations = [
  `CREATE TABLE template_versions (
     id INTEGER PRIMARY KEY,
     template TEXT NOT NULL,
     html TEXT NOT NULL,
     note TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX template_versions_by_template ON template_versions (template, id);

   CREATE TABLE renders (
     id TEXT PRIMARY KEY,               -- hash of template html and fields, so a retry finds the same row
     template TEXT NOT NULL,
     template_version INTEGER NOT NULL,
     fields TEXT NOT NULL,              -- JSON
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     posted_at TEXT,                    -- set by the Buffer step in phase 3
     deleted_at TEXT
   );`,

  `ALTER TABLE template_versions RENAME COLUMN template TO name;
   ALTER TABLE template_versions RENAME COLUMN html TO body;

   CREATE TABLE prompt_versions (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     body TEXT NOT NULL,
     note TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX prompt_versions_by_name ON prompt_versions (name, id);

   CREATE TABLE claude_usage (         -- one row per Claude call; the spend cap reads this
     id INTEGER PRIMARY KEY,
     job TEXT NOT NULL,                -- for example copy:social-post or test:caption
     model TEXT NOT NULL,
     input_tokens INTEGER NOT NULL,
     output_tokens INTEGER NOT NULL,
     cost_usd REAL NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );`,

  `CREATE TABLE posts (                -- one row per image per Buffer channel
     id INTEGER PRIMARY KEY,
     idempotency_key TEXT NOT NULL,
     render_id TEXT NOT NULL REFERENCES renders (id),
     channel_id TEXT NOT NULL,
     channel_name TEXT NOT NULL DEFAULT '',
     text TEXT NOT NULL,
     mode TEXT NOT NULL,               -- queue, scheduled or draft
     due_at TEXT,                      -- ISO time, for scheduled posts
     status TEXT NOT NULL,             -- pending_approval, approved, sending, sent, failed, check_buffer, rejected
     buffer_post_id TEXT,              -- set once Buffer accepts it: never send again
     error TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     decided_at TEXT,
     sent_at TEXT,
     UNIQUE (idempotency_key, channel_id)
   );`,
];

const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
for (let v = user_version; v < migrations.length; v++) {
  db.exec(`BEGIN; ${migrations[v]}; PRAGMA user_version = ${v + 1}; COMMIT;`);
}
