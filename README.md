# Red Cherry IT social and content tool

Phase 1: the renderer and editor. Fills an HTML template with text and saves it as a 1080 by 1080 PNG.
Phase 2: Claude copywriting. Writes the text for a template, checks it fits, and writes a caption.
CLAUDE.md is the full brief. PLAN.md has the data model and the plan for later phases.

## Run it locally
Needs Node 22.18 or newer.

    npm install
    cp .env.example .env        # then set API_KEY and DATA_DIR=./data
    npm start                   # editor at http://127.0.0.1:3000
    npm test                    # renders every template and checks an overlong headline is refused

Set `RENDER_SAMPLES_DIR=/some/folder` when running the tests to keep each sample PNG for checking by eye.

## Settings
All in environment variables, listed in `.env.example`.

| Variable | Default | What it does |
| --- | --- | --- |
| `API_KEY` | none, required | Sent as the `x-api-key` header. The app will not start without it. |
| `DATA_DIR` | `./data` (`/data` in Docker) | Database and rendered PNGs. |
| `PORT`, `HOST` | `3000`, `127.0.0.1` | Where it listens. |
| `RENDER_RETENTION_DAYS` | `14` | Unposted renders older than this are deleted hourly. Posted ones go 3 days after they go out. |
| `RENDERS_PER_MIN` | `30` | Render rate limit. Other endpoints allow 600 a minute. |
| `TEMPLATE_VERSIONS_KEEP` | `50` | Saved versions kept per template and per prompt. |
| `ANTHROPIC_API_KEY` | none | Console API key for copywriting. Without it only the copywriting endpoints are off. |
| `CLAUDE_MONTHLY_CAP_GBP` | `20` | Hard stop on Claude spend each calendar month. |
| `GBP_PER_USD` | `0.79` | Rate for converting the API's dollar prices. |
| `BUFFER_API_KEY` | none | Buffer API key. Without it only the Buffer endpoints are off. |
| `PUBLIC_URL` | none | The app's public address. Buffer fetches images from here, so posting needs it. |
| `AUTO_POST` | `false` | When true, posts go to Buffer as soon as they are added, with no approval. |
| `PUBLISH_DIR` | `DATA_DIR/site` | Where published articles are written. Point it at your static site's folder to publish straight into it. |
| `SITE_URL` | `https://redcherryit.com` | Used for article links in social posts. |

## API
Every endpoint needs `x-api-key`, except `/health`, the editor page with its fonts, logo and check script, and `/public/renders/<id>.png` (Buffer fetches images from there; ids are long random looking hashes that cannot be listed).

* `POST /render` with `{"template": "social-post", "fields": {"headline": "...", "highlight_word": "...", "subtitle": "...", "tag": "...", "footer_left": "...", "footer_right": "..."}}` returns the PNG. Add `?format=json` to get `{id, url}` instead. The same template and text always give the same render, so a retry never makes a second image.
* If the text does not fit you get a 422 with a list of problems, each naming the field, the overflow in pixels and roughly how many characters to cut.
* `GET /renders/<id>.png` fetches an earlier render.
* `GET /templates`, `GET /templates/<name>` (HTML, fields and sample text), `PUT /templates/<name>` with `{html, note}` saves a new version, `GET /templates/<name>/versions`, `POST /templates/<name>/rollback/<version>`.
* `GET /health` for the container healthcheck.

A new line in a headline forces a line break. Fields are capped at 300 characters and are always escaped, so no field can change the design.

## Copywriting
* `POST /copy` with `{"template": "social-post", "topic": "...", "url": "...", "keyword": "...", "audience": "...", "sources": "..."}` returns `fields` ready for `/render`, plus `caption`, `hashtags`, `fits`, `problems` and `cost_gbp`. Nothing is posted or queued.
* Give `url` (with or without a topic) and the app reads that page as plain text and hands it to Claude as a source, so the post is about the page and uses its facts. Only public web addresses are read, and pages that need JavaScript to show their text will not work; paste the text into `sources` for those.
* Sonnet 5.5 writes the image text. The app then runs the same layout check as a render, and if the text does not fit it asks Claude once to shorten it, saying what overflowed. Haiku 5.5 writes the caption.
* Prompts live in `prompts/` as seeds and are versioned in the database like templates: `GET /prompts`, `GET /prompts/<name>`, `PUT /prompts/<name>` with `{body, note}`, `GET /prompts/<name>/versions`, `POST /prompts/<name>/rollback/<version>`.
* `POST /prompts/<name>/test` with `{vars, body?, template?}` runs a prompt, saved or not, and shows the output.
* `brand-voice` is added to every call as the system prompt. Its `{examples}` slot is filled with every file in `prompts/examples/`.
* A prompt can start with settings between `---` lines: `model`, `effort` (low, medium or high) and `max_tokens`.
* `POST /templates/design` with `{"description": "...", "base": "social-post"}` has Claude design a new template in the brand style, starting from an existing one. The app checks the rules (only the six standard fields, no scripts, nothing loaded from outside) and that the sample text fits, and gives Claude one fix up round if not. It returns `{name, html, sample, ok, problems, cost_gbp}` and saves nothing; save it with `PUT /templates/<name>`. The editor's "Design a template with Claude" panel does all this with a preview.
* Every Claude call goes through `src/claude.ts`. It refuses any call whose worst case cost would take this month over the cap, and logs tokens and cost to the `claude_usage` table. `GET /usage` shows this month's spend and the last 20 calls.

## Buffer
* `GET /buffer/channels` lists the channels in every Buffer organisation.
* `POST /posts` with `{"render_id": "...", "channels": [{"id": "...", "name": "..."}], "text": "...", "mode": "queue"}` adds one post per channel. `mode` is `queue` (next free Buffer slot), `scheduled` (add `due_at`, an ISO time in the future) or `draft` (a Buffer draft). Posts wait with status `pending_approval`. Sending the same thing twice returns the same posts; pass `idempotency_key` to set the key yourself.
* `POST /posts/<id>/approve` sends it to Buffer. `POST /posts/<id>/reject` drops it. `GET /posts` lists open and recent posts, `?status=sent` filters.
* A post is only ever sent once: approving claims it in one database step, and once Buffer returns an id it is never sent again. If Buffer says no, the status is `failed` with the reason, and you can send again. If the request may have reached Buffer but the answer was lost (timeout, network or server error), the status is `check_buffer`: look in Buffer, then `POST /posts/<id>/mark-sent` or send again.
* The editor's "Post to Buffer" panel does all this. Write with Claude fills in its caption.
* Only images are sent. Video support in Buffer's API is still to be checked, so videos (phase 5) will be saved for you to post by hand until then.

## Articles
* `POST /articles` with `{"topic": "...", "keyword": "...", "audience": "...", "sources": "...", "url": "...", "category": "/guides/stories/"}` has Claude (Sonnet 5.5) draft an article in the case study structure, using only facts from the sources and the page link. It is saved as a draft and returned with its checks.
* The checks are plain code: word count, required headings, sources present, no `[SOURCE NEEDED]` left in, and no dashes used as punctuation. These must pass before approval. Figures and quotes that do not appear in the sources are listed as warnings to look at. The limits and headings live in the `article` prompt's settings, so they are versioned with it.
* `GET /articles`, `GET /articles/<id>`, `PUT /articles/<id>` (edit title, summary, slug, body or sources; drafts only), then `POST /articles/<id>/approve`, `/reject`, `/reopen` (back to draft) and `/publish`.
* Publishing writes `<slug>.md` (with front matter like your example) and `<slug>.html` (the article as an HTML fragment) to `PUBLISH_DIR/<category>/`. Publishing again overwrites the same files. `GET /articles/<id>/download?format=md` or `html` gets either file.
* `POST /articles/<id>/social` with `{"template", "channels", "mode"}` writes a social post for a published article, renders it and adds it to the Buffer approval queue with the article link in the caption. Asking again for the same article and template returns the same posts without calling Claude.
* The editor's "Articles" panel does all this, with a preview.

## Templates
`templates/` holds the four starting templates: social post, quote card, stat card and tip card. On start, any template file whose exact HTML is not already in the database is added as a new version. After that, edits made in the editor are the live version, and every save can be rolled back.

To make a new template, copy one and keep `class="post"` on the 1080 by 1080 box, `data-field="<name>"` on each text block, and `{{name}}` where the text goes. Blocks must be direct children of `.post` so the overflow check can measure them.

The logo is `assets/logo.png`. Replace that file (same name) and every template picks it up. An SVG version would stay sharper if you have one.

## Deploy on Coolify
1. Push this folder to a Git repository and add it in Coolify as a Docker Compose resource. It uses `docker-compose.yml`.
2. Set `API_KEY` (a long random string) in the resource's environment variables. The other settings are optional.
3. Give the `app` service a domain on port 3000. Coolify's proxy adds HTTPS.
4. Deploy. Data lives in the `data` volume, so redeploys keep the database, renders and template edits. The healthcheck is built into the image.

Renders run one at a time and use one shared Chromium, so a 1 GB server copes, but add swap if it has none.
