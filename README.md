# Red Cherry IT social and content tool

The studio page has two areas, picked from the top bar. Marketing has Social (image, Write with Claude, Post to Buffer, calendar), Articles, Templates (code, versions and the designer) and Prompts. Sales has Campaigns and Leads, where the old PHP leads tool is moving in one part at a time. Each page lists its area with `data-section` on its nav link.

Phase 1: the renderer and editor. Fills an HTML template with text and saves it as a 1080 by 1080 PNG.
Phase 2: Claude copywriting. Writes the text for a template, checks it fits, and writes a caption.
CLAUDE.md is the full brief. PLAN.md has the data model and the plan for later phases.

## Run it locally
Needs Node 22.18 or newer.

    npm install
    cp .env.example .env        # then set API_KEY and DATA_DIR=./data
    npm start                   # studio at http://127.0.0.1:3000
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
| `CLAUDE_MONTHLY_CAP_GBP` | `20` | Hard stop on AI spend (Claude and the OpenAI fallback together) each calendar month. |
| `OPENAI_API_KEY` | none | Fallback: when Claude is down or overloaded, writing jobs go to OpenAI instead, under the same monthly cap. Research and Find sources stay Claude only (they use Claude's web search). |
| `OPENAI_MODEL`, `OPENAI_INPUT_USD_PER_M`, `OPENAI_OUTPUT_USD_PER_M` | `gpt-5`, `1.25`, `10` | The fallback model and its prices per million tokens, used for the cap. |
| `GBP_PER_USD` | `0.79` | Rate for converting the API's dollar prices. |
| `BUFFER_API_KEY` | none | Buffer API key. Without it only the Buffer endpoints are off. |
| `PUBLIC_URL` | none | The app's public address. Buffer fetches images from here, so posting needs it. |
| `AUTO_POST` | `false` | When true, posts go to Buffer as soon as they are added, with no approval. |
| `SITE_REPO` | none | The website's GitHub repo, for example `Hambowsky/red-cherry-it-website`. When set, Publish commits to it. |
| `SITE_BRANCH` | `main` | The branch 20i deploys from. |
| `SITE_GITHUB_TOKEN` | none | Fine grained GitHub token with Contents read and write on the website repo only. |
| `PUBLISH_DIR` | `DATA_DIR/site` | Without `SITE_REPO`, published pages are saved here to upload by hand. |
| `SITE_URL` | `https://redcherryit.com` | Used for article links, canonical URLs and the sitemap. |
| `GOOGLE_PLACES_API_KEY` | none | Google Maps search for campaigns. The key needs Places API (New) enabled. |
| `PLACES_MONTHLY_CALLS` | `900` | Most Google searches a month, under Google's 1,000 free. Cached answers do not count. |
| `FIRECRAWL_API_KEY` | none | Directory search (Yell, Checkatrade and others) for campaigns. |
| `FIRECRAWL_MONTHLY_CALLS` | `500` | Most Firecrawl searches a month. |
| `FIRECRAWL_SCRAPE_MONTHLY_CALLS` | `1000` | Most website pages a month read through Firecrawl, used only when the server cannot load a site itself (1 credit each, a failed read costs nothing). |

## API
Every endpoint needs `x-api-key`, except `/health`, the editor page with its fonts, logo and check script, and `/public/renders/<id>.png` (Buffer fetches images from there; ids are long random looking hashes that cannot be listed).

* `POST /render` with `{"template": "social-post", "fields": {"headline": "...", "highlight_word": "...", "subtitle": "...", "tag": "...", "footer_left": "...", "footer_right": "..."}}` returns the PNG. Add `?format=json` to get `{id, url}` instead. The same template and text always give the same render, so a retry never makes a second image.
* If the text does not fit you get a 422 with a list of problems, each naming the field, the overflow in pixels and roughly how many characters to cut.
* `GET /renders/<id>.png` fetches an earlier render.
* `POST /render/video` with the same body (plus an optional `size`), for a motion template, returns `{id, url}` once the MP4 is made (a minute or so). The file is at `/public/renders/<id>.mp4`.
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
* `POST /templates/design` with `{"description": "...", "base": "social-post"}` has Claude design a new template in the brand style, starting from an existing one. The app checks the rules (only the six standard fields, no scripts, nothing loaded from outside) and that the sample text fits, and gives Claude one fix up round if not. It answers `202 {job}` straight away, since Claude can take minutes; `GET /jobs/<job>` gives `{done: false}` until it gives `{done: true, result: {name, html, sample, ok, problems, cost_gbp}}` (or the error). It saves nothing; save it with `PUT /templates/<name>`. The editor's "Design a template with Claude" panel does all this with a preview.
* Every Claude call goes through `src/claude.ts`. It refuses any call whose worst case cost would take this month over the cap, and logs tokens and cost to the `claude_usage` table. `GET /usage` shows this month's spend and the last 20 calls.

## Buffer
* `GET /buffer/channels` lists the channels in every Buffer organisation.
* `POST /posts` with `{"render_id": "...", "channels": [{"id": "...", "name": "..."}], "text": "...", "mode": "queue"}` adds one post per channel. `mode` is `queue` (next free Buffer slot), `scheduled` (add `due_at`, an ISO time in the future) or `draft` (a Buffer draft). Posts wait with status `pending_approval`. Sending the same thing twice returns the same posts; pass `idempotency_key` to set the key yourself.
* `POST /posts/<id>/approve` sends it to Buffer. `POST /posts/<id>/reject` drops it. `GET /posts` lists open and recent posts, `?status=sent` filters.
* A post is only ever sent once: approving claims it in one database step, and once Buffer returns an id it is never sent again. If Buffer says no, the status is `failed` with the reason, and you can send again. If the request may have reached Buffer but the answer was lost (timeout, network or server error), the status is `check_buffer`: look in Buffer, then `POST /posts/<id>/mark-sent` or send again.
* The Social page's "Post to Buffer" card does all this. Write with Claude fills in its caption. Its calendar shows posts on the day they go out (scheduled time, or the day a queue post went to Buffer); picking a future day sets a scheduled time. Posts waiting for approval are listed beside it.
* A post carries the image or, for a motion template, the MP4 (pick Attach on the Social page). Buffer fetches the file from `/public/renders/`. Instagram gets a video as a reel that also shows in the feed; Facebook gets it as a normal post.

## Articles
* `POST /articles` with `{"topic": "...", "keyword": "...", "audience": "...", "sources": "...", "url": "...", "category": "/guides/stories/"}` has Claude (Sonnet 5.5) draft an article in the case study structure, using only facts from the sources and the page link. It is saved as a draft and returned with its checks.
* The checks are plain code: word count, required headings, sources present, no `[SOURCE NEEDED]` left in, and no dashes used as punctuation. These must pass before approval. Figures and quotes that do not appear in the sources are listed as warnings to look at. The limits and headings live in each category's prompt settings, so they are versioned with it.
* Each category has its own structure prompt named `article-<folder>`, for example `article-learn` for `/guides/learn/`. The Category menu lists every such prompt, so saving a new one (say `article-tools`) in the Prompts section adds that category. All categories share the page layout in `site/article.html`. A `section:` setting in the prompt gives the breadcrumb name, for example `Checklists & Templates`.
* Picking a category lists the tool's articles and the pages already in that website folder. Choosing a website page imports it as a published article (its own text becomes its sources), so it can be edited with Edit again and published again. Publishing over a live page keeps that page's Related Reading cards and banner heading.
* On Social, Write with Claude has a "From an article" menu listing every live guide (`GET /articles/live`). Picking one fills the page link; for a guide the image tag is its category and the headline is a fresh hook, not the title.
* Research ideas (`POST /articles/research {category, focus?}`) has Claude search the web (up to 5 searches, about a penny each, counted in the spend cap) and suggest articles the category does not have yet, each with its sources. "Use this idea" fills in the New article form and runs Find sources (`POST /articles/sources`), which searches the web for facts on the topic and adds them to Sources with their links (facts without a link are dropped). Ideas with no source are flagged. Edit the `research` prompt to change what it looks for.
* `GET /articles`, `GET /articles/<id>`, `PUT /articles/<id>` (edit title, summary, slug, body or sources; drafts only), then `POST /articles/<id>/approve`, `/reject`, `/reopen` (back to draft) and `/publish`.
* Publishing builds the full page from `site/article.html`, a copy of a live story page with slots, so it matches the rest of the guides: short answer box, author line, FAQ schema, breadcrumbs, related reading and call to action. With `SITE_REPO` set it makes one commit to the website repo with the new page, its card at the end of the category's `index.html`, and its line in `sitemap.xml`, and 20i deploys it. Publishing again updates the same page and changes nothing else. If the site's header, footer or styles change, update `site/article.html` to match.
* `GET /articles/<id>/download?format=html` gets the finished page, `format=md` a Markdown copy with front matter.
* `POST /articles/<id>/social` with `{"template", "channels", "mode"}` writes a social post for a published article, renders it and adds it to the Buffer approval queue with the article link in the caption. Asking again for the same article and template returns the same posts without calling Claude.
* Publishing also makes a featured image from the `article-header` template (1200 by 630, the title with the keyword in red when the title contains it), saved as `images/<category>/<slug>.png`. It is not shown on the page: `og:image` (with its size and alt text) and the Article schema point to it, so link previews and Google use it. An unchanged image is not committed again. If the title is too long for the image, the article still publishes with the site's standard image and the reply says why.
* The Articles page does all this, with a preview. Publishing also updates the guide count on the guides hub page.

## Sales
A campaign is industries, towns, what you are looking for (no website, an outdated one, or either), the most leads per run and where to search. Run finds businesses on Google Maps and in UK directories, checks each website it finds, and keeps the ones that fit as leads. A run works in the background, one at a time, and the Campaigns page shows its progress.

* The industries box suggests common UK business types as you type, and the towns box suggests real UK towns and cities from Google (`GET /campaigns/towns?q=`, cached a day, at most 5,000 a month, inside Google's 10,000 free). Picking one adds it to the list.
* A website is outdated when it has no SSL, no mobile viewport, or a copyright year two or more years old. A site that does not load counts as no website. SEO gaps (title, description, headings, alt text, canonical, structured data, social tags) are listed on the lead but do not decide it. Sites behind bot protection are kept with a note.
* The same business is never added twice, across all campaigns: name and town make the key. Running a campaign again only adds new businesses, and the same search on the same day comes from a cache at no cost.
* Each run shows what it cost: Google searches (the first 1,000 a month are free, then about 3p each at Google's Text Search Enterprise price) and Firecrawl credits. The Campaigns page shows the month so far.
* **Analyse** (one lead from its page, or a campaign's leads in the background) adds a mobile PageSpeed score, when the domain was registered (RDAP), the Google Business Profile (rating, reviews, opening hours, photos), a screenshot of the homepage, and Claude's priority (hot, warm or cold), a note on why and an opening line for an email or call. Claude's part uses the editable `lead-review` prompt (Haiku, well under a penny a lead) within the monthly cap. Anything that cannot be looked up is listed on the lead and the rest still saves. PageSpeed needs the PageSpeed Insights API turned on for `GOOGLE_PLACES_API_KEY`. When the website links no social profiles (or there is no website), one Firecrawl search looks for Facebook, Instagram, LinkedIn and X profiles by business name; only results naming the business count. If the registry refuses the domain age lookup, Firecrawl fetches it instead. Screenshots are kept in `DATA_DIR/leads` and go with the lead.
* **Emails** (Sales, Emails). On a lead with an email address, **Draft an email** first checks Companies House: only an active limited company (or LLP) of the same name can be emailed, because PECR treats sole traders and partnerships as individuals who must opt in. Those are marked for a call instead. Claude then writes the email with the editable `outreach-email` prompt (Sonnet, about 2p). It waits on the Emails page, where you can edit it, send yourself a test, approve or reject it. Approved emails send from your mailbox over SMTP one at a time, `OUTREACH_DELAY_SECONDS` apart and at most `OUTREACH_DAILY_CAP` a day; the rest wait for the next day. Each email is sent at most once: if the connection drops mid send it is marked **Check if it went** and never retried on its own. Every email ends with an unsubscribe link (`PUBLIC_URL/unsubscribe`, plus the one click header mail apps use); opening it only asks, and the button adds the address to the **Do not email** list, which is checked before drafting and again before sending. Paste the old tool's suppression list into that list before sending anything.
* Deleting a campaign deletes its leads that are still New. Leads you have worked on stay.
* Leads have a status, a follow up date, contact details you can correct, and notes. Status changes are logged with the notes.
* API: `GET/POST /campaigns`, `GET/PUT/DELETE /campaigns/<id>`, `POST /campaigns/<id>/run`, `POST /campaigns/<id>/analyse`, `POST /leads/<id>/analyse`, `GET /leads/<id>/screenshot.jpg`, `GET /leads?campaign=&status=&priority=&q=&has_website=&has_email=&has_phone=&sort=` (has_* take yes or no; status also takes active or contacted_plus; sort is newest, priority, name or town), `GET/PUT /leads/<id>`, `POST /leads/<id>/notes`.

## Templates
`templates/` holds the four starting templates: social post, quote card, stat card and tip card. On start, any template file whose exact HTML is not already in the database is added as a new version. After that, edits made in the editor are the live version, and every save can be rolled back.

To make a new template, copy one and keep `class="post"` on the 1080 by 1080 box, `data-field="<name>"` on each text block, and `{{name}}` where the text goes. Blocks must be direct children of `.post` so the overflow check can measure them.

### One off changes
On the Social page, "Change this post only" asks Claude to change a copy of the template for one post, for example snow for a Christmas article. The copy goes with that post's preview, PNG and video (`html` in `/render` and `/render/video`, made by `POST /templates/tweak` with `{template, change, fields, size}`, which runs as a job like `/templates/design`); the saved template never changes. Decorations carry `data-decor`, which the layout check skips, so they can sit over or behind the text. The prompt is `template-tweak` in the Prompts section.

### Motion templates
The four `motion-` templates (blueprint, glow, isometric, whiteboard) are upright 1080 by 1920 clips, silent, 12 seconds at 30 frames a second. They use the same text fields, so Write with Claude works on them as usual. A motion template marks `.post` with `data-size="1080x1920"` and `data-seconds="12"`, and animates with plain CSS animations that end (no endless loops). The layout check and the PNG use the last frame. The video is made by pausing the page, stepping every animation one frame at a time, taking a screenshot of each and piping them to ffmpeg, so a slow server makes a slow render but never a jerky clip. The MP4 can go straight to Buffer with the post, or be downloaded.

Each motion template also comes in portrait 1080 by 1350 and square 1080 by 1080: pick a Size on the Social page, or send `"size": "1080x1080"` to `/render`, `/render/video` or `/copy`. A template lists its sizes in `data-sizes` on `.post`, and its CSS lays each one out with `.post[data-size="..."]` rules (the scene shrinks with `zoom`, the text gets a little smaller).

The logo is `assets/logo.png`. Replace that file (same name) and every template picks it up. An SVG version would stay sharper if you have one.

## Deploy on Coolify
1. Push this folder to a Git repository and add it in Coolify as a Docker Compose resource. It uses `docker-compose.yml`.
2. Set `API_KEY` (a long random string) in the resource's environment variables. The other settings are optional.
3. Give the `app` service a domain on port 3000. Coolify's proxy adds HTTPS.
4. Deploy. Data lives in the `data` volume, so redeploys keep the database, renders and template edits. The healthcheck is built into the image.

Renders run one at a time and use one shared Chromium, so a 1 GB server copes, but add swap if it has none.
