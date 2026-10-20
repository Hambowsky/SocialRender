# Red Cherry IT tool: phase 1 plan

## Stack
* Node 22 with TypeScript, run directly by Node's built in type stripping. No build step, no compiled output to keep in sync. `tsc --noEmit` as a dev check only.
* Fastify for the API. Rate limiting and static files are a few lines of our own, so Fastify and Playwright are the only runtime dependencies.
* SQLite through Node's built in `node:sqlite`, so no native SQLite package to compile.
* Playwright with one persistent Chromium, relaunched automatically if it crashes. Renders go through a single queue, one at a time.
* Plain HTML templates with `{{field}}` slots. Editor is one vanilla HTML and JS page served by the app.
* Archivo font files (400, 500, 900) shipped in the repo and loaded locally, so renders never depend on Google Fonts.
* Docker image based on `mcr.microsoft.com/playwright:v1.56.1-noble`, healthcheck on `/health`, volume at `/data`.

## Folder layout
```
src/
  config.ts       every env var in one place
  server.ts       Fastify app, auth, limits, routes
  render.ts       browser, queue, screenshot
  templates.ts    load, fill, save versions, roll back
  db.ts           SQLite open and migrations
  cleanup.ts      deletes old renders on a timer
  claude.ts       phase 2: the one function every Claude call goes through
public/
  editor.html     editor page
  check.js        layout check, shared by preview and renderer
templates/        seed templates: social-post, quote-card, stat-card, tip-card
assets/           logo (placeholder until the real file arrives)
fonts/            Archivo woff2 files
prompts/          phase 2 prompt files
test/             render every template, reject an overlong headline
Dockerfile  .env.example  README.md  CLAUDE.md
/data (volume)    app.db, renders/
```
Template files are seeds. On start they are loaded into the database as versions, and edits from the editor are saved there too, so a redeploy never wipes them.

## Data model (SQLite)
Phase 1 creates `template_versions` and `renders`. `jobs` arrives in phase 2, when the first background work does. The rest are listed so later phases slot in without changing these.
* `jobs`: id, kind (render, copy, post, article, email), idempotency_key UNIQUE, status (queued, running, done, failed, needs_approval, approved), input JSON, output JSON, error, attempts, created_at, updated_at. A retry with the same key returns the existing job instead of doing the work again.
* `renders`: id (hash of template and text), template, template_version, fields, created_at, posted_at, deleted_at.
* `template_versions`: id, template, html, note, created_at. Saving creates a new row; rolling back copies an old row forward.
* Phase 2: `prompt_versions` (same shape as template versions), `claude_usage` (job_id, model, input_tokens, output_tokens, cost_pence, created_at). The spend cap reads this table.
* Phase 3: `posts` (job_id, channel, buffer_id, scheduled_for, status). Posting needs status approved; `buffer_id` set means never send again.
* Phase 4: `drafts` (kind, title, body, sources JSON, checks JSON, status draft, review, approved, published).
* Phase 5: `contacts` and `suppressions` for email.

## API
* `GET /health` (no key)
* `POST /render` returns the PNG. Add `?format=json` to get the id, URL and size instead.
* `GET /templates`, `GET /templates/:name`, `PUT /templates/:name` (saves a version), `GET /templates/:name/versions`, `POST /templates/:name/rollback/:version`
* `GET /renders/:id.png`
* Everything except `/health` needs `x-api-key`. Body limit 64 KB, each field capped at 300 characters, rate limit per key.

## Overflow check
Runs in the browser after fonts load. Each text box is checked for overflow past its own edges, overlap with any other block, and leaving the 1080 square. The error names the field and how much: for example `headline overlaps subtitle by 28px, roughly 1 line; shorten it by about 12 characters`.

## Where I differ from CLAUDE.md
1. The brief says nobody can change anything but text fields. Your spec adds HTML and CSS editing in the editor. I will keep both: the API and Hermes can only send text, and only the editor (with your key) can change template code, always as a saved version.
2. Your reference headline only fits because of a hard line break. Without it, it runs into the subtitle. A new line in the headline field will still force a break.
3. Font: I ship the font files with the app instead of installing them system wide. Same result, and it works inside Docker with no extra step.
