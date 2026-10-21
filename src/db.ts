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

  `CREATE TABLE articles (
     id INTEGER PRIMARY KEY,
     slug TEXT NOT NULL UNIQUE,
     category TEXT NOT NULL,           -- site path, for example /guides/stories/
     title TEXT NOT NULL,
     summary TEXT NOT NULL,
     body TEXT NOT NULL,               -- Markdown
     topic TEXT NOT NULL,
     keyword TEXT NOT NULL DEFAULT '',
     sources TEXT NOT NULL,            -- what Claude was given, kept so claims can be checked against it
     status TEXT NOT NULL,             -- draft, approved, published, rejected
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now')),
     published_at TEXT
   );`,

  `CREATE TABLE campaigns (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     industries TEXT NOT NULL,         -- comma separated, every industry is searched in every town
     towns TEXT NOT NULL,
     lead_type TEXT NOT NULL,          -- no_website, outdated_website or both
     max_leads INTEGER NOT NULL,
     sources TEXT NOT NULL,            -- comma separated: places, directories
     status TEXT NOT NULL DEFAULT 'draft', -- draft, running, done, failed
     last_run_at TEXT,
     last_run_summary TEXT,            -- JSON, or the error when a run failed
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE leads (
     id INTEGER PRIMARY KEY,
     campaign_id INTEGER REFERENCES campaigns (id) ON DELETE SET NULL,
     dedup_key TEXT NOT NULL UNIQUE,   -- the same business is never added twice, whichever campaign finds it
     company_name TEXT NOT NULL,
     contact_name TEXT NOT NULL DEFAULT '',
     phone TEXT NOT NULL DEFAULT '',
     email TEXT NOT NULL DEFAULT '',
     website_url TEXT NOT NULL DEFAULT '',
     address TEXT NOT NULL DEFAULT '',
     postcode TEXT NOT NULL DEFAULT '',
     town TEXT NOT NULL DEFAULT '',
     industry TEXT NOT NULL DEFAULT '',
     source TEXT NOT NULL,             -- places, or the directory it came from
     source_ref TEXT NOT NULL DEFAULT '',
     has_website INTEGER NOT NULL,
     website_issues TEXT NOT NULL DEFAULT '{}',
     seo_issues TEXT NOT NULL DEFAULT '{}',
     social_links TEXT NOT NULL DEFAULT '{}',
     rating REAL,
     reviews INTEGER,
     lead_reason TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'new', -- new, contacted, replied, bounced, converted, not_interested, not_a_fit, archived
     follow_up_date TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX leads_campaign ON leads (campaign_id);
   CREATE TABLE lead_activity (
     id INTEGER PRIMARY KEY,
     lead_id INTEGER NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
     kind TEXT NOT NULL,               -- note or status
     text TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE api_cache (            -- paid search answers, kept a day so a rerun costs nothing
     key TEXT PRIMARY KEY,
     body TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );`,

  `ALTER TABLE leads ADD COLUMN analysis TEXT NOT NULL DEFAULT '{}'; -- PageSpeed, domain age, Business Profile, Claude's notes and pitch
   ALTER TABLE leads ADD COLUMN priority TEXT;                         -- hot, warm or cold, from Claude
   ALTER TABLE leads ADD COLUMN analysed_at TEXT;`,
];

const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
for (let v = user_version; v < migrations.length; v++) {
  db.exec(`BEGIN; ${migrations[v]}; PRAGMA user_version = ${v + 1}; COMMIT;`);
}
