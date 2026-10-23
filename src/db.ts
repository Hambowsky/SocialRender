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

  `CREATE TABLE emails (                -- outreach: drafted by Claude, approved by David, sent at most once
     id INTEGER PRIMARY KEY,
     lead_id INTEGER REFERENCES leads (id) ON DELETE SET NULL,
     to_email TEXT NOT NULL,
     subject TEXT NOT NULL,
     body TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending_approval', -- pending_approval, approved, sending, sent, failed, check_sent, rejected, bounced
     error TEXT,
     message_id TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     approved_at TEXT,
     sent_at TEXT
   );
   CREATE UNIQUE INDEX emails_one_open ON emails (lead_id) WHERE status IN ('pending_approval', 'approved', 'sending');
   CREATE TABLE suppression (           -- never email these: unsubscribed, bounced or added by hand
     email TEXT PRIMARY KEY,
     reason TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   -- JSON from Companies House: {registered, name, number} or {registered: false}
   ALTER TABLE leads ADD COLUMN company_check TEXT`,

  `CREATE TABLE settings (             -- small bits of state, such as how far the inbox has been read
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,

  `CREATE TABLE case_studies (         -- David's past clients, so an outreach email can name one in the lead's line of business
     id INTEGER PRIMARY KEY,
     client TEXT NOT NULL UNIQUE COLLATE NOCASE,
     industry TEXT NOT NULL,
     blurb TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   INSERT INTO case_studies (client, industry, blurb) VALUES
     ('Alston Hostel', 'Hostels and accommodation', 'We built Alston Hostel, an independent hostel on the Pennine Way in Cumbria, a booking friendly website.'),
     ('Apex Data Intelligence', 'IT consultancies', 'We built Apex Data Intelligence, a Databricks consultancy, a clear website that explains its complex services and is designed to win enquiries.'),
     ('Autobarn Garage', 'Garages and MOT centres', 'We built Autobarn Garage, a BMW, Mini and Mercedes specialist, a website focused on driving service and MOT bookings.'),
     ('Balls of Prudhoe', 'Restaurants and takeaways', 'We built a website for Balls of Prudhoe, an award winning fish and chip restaurant, to match its reputation and win more bookings.'),
     ('Carousel Gifts', 'Retailers and gift shops', 'We built Carousel Gifts, a Darras Hall gift shop with over 21 years of trading, a full ecommerce store that accepts gift cards and coupons and has built in email marketing.'),
     ('Elliott Spoors Roofing and Solar Panels', 'Roofers', 'We built Elliott Spoors Roofing and Solar Panels, trusted roofing and solar experts in the North East, a lead generating website.'),
     ('Greener Miles Running', 'Event organisers', 'We built a website for Greener Miles Running, an eco friendly trail running events company in the North East, to promote and fill its events.'),
     ('Johnson Decorators', 'Painters and decorators', 'We built Johnson Decorators, a painting and decorating firm in Newcastle upon Tyne, a website designed to generate quote requests.'),
     ('Metro Security Services', 'Security and alarm installers', 'We built a professional website for Metro Security Services, a North East alarm, CCTV and fire safety installer with over 30 years of experience.'),
     ('North East Damp Control', 'Damp proofing specialists', 'We built North East Damp Control, specialists in damp proofing, condensation control and timber treatments, a lead generating website.'),
     ('On Tyne Remedials', 'Damp proofing specialists', 'We built On Tyne Remedials, specialists in damp proofing and timber treatments across Tyneside, a lead generating website.'),
     ('OPUS Building Services', 'Building services contractors', 'We built a website for OPUS Building Services, a leading mechanical, electrical and building services contractor working across the UK.'),
     ('Orangutan Landscapes', 'Landscapers and gardeners', 'We built Orangutan Landscapes, a garden and landscaping business in County Durham, a lead generating website.'),
     ('Skywave Communications', 'Telecoms providers', 'We built a website for Skywave Communications, a specialist telecoms and auto dialling provider, that explains its technology clearly.'),
     ('Time To Shine', 'Cleaning companies', 'We built Time To Shine, a domestic and commercial cleaning company in the North East, a website with online booking.'),
     ('True Precision Engineering', 'Engineering and machining', 'We built a website for True Precision Engineering, an ISO accredited sub contract precision machining specialist.'),
     ('Tyneside Damp Specialists', 'Damp proofing specialists', 'We built Tyneside Damp Specialists, experts in damp proofing and timber treatments, a lead generating website.'),
     ('Tyne Tees Woodworm', 'Pest control and woodworm treatment', 'We built Tyne Tees Woodworm, professional woodworm and pest treatment specialists across the North East, a lead generating website.'),
     ('Whites Building and Groundworks', 'Builders and groundworkers', 'We built Whites Building and Groundworks, a general building contractor based in Blaydon-on-Tyne, a lead generating website.')`,
];

const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
for (let v = user_version; v < migrations.length; v++) {
  // On its own line, so a comment at the end of a migration cannot swallow the version bump and the commit.
  db.exec(`BEGIN;\n${migrations[v]};\nPRAGMA user_version = ${v + 1};\nCOMMIT;`);
}
