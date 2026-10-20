# Red Cherry IT social and content tool

Phase 1: the renderer and editor. Fills an HTML template with text and saves it as a 1080 by 1080 PNG.
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
| `RENDER_RETENTION_DAYS` | `14` | Unposted renders older than this are deleted hourly. |
| `RENDERS_PER_MIN` | `30` | Render rate limit. Other endpoints allow 600 a minute. |
| `TEMPLATE_VERSIONS_KEEP` | `50` | Saved versions kept per template. |

## API
Every endpoint needs `x-api-key`, except `/health` and the editor page with its fonts, logo and check script.

* `POST /render` with `{"template": "social-post", "fields": {"headline": "...", "highlight_word": "...", "subtitle": "...", "tag": "...", "footer_left": "...", "footer_right": "..."}}` returns the PNG. Add `?format=json` to get `{id, url}` instead. The same template and text always give the same render, so a retry never makes a second image.
* If the text does not fit you get a 422 with a list of problems, each naming the field, the overflow in pixels and roughly how many characters to cut.
* `GET /renders/<id>.png` fetches an earlier render.
* `GET /templates`, `GET /templates/<name>` (HTML, fields and sample text), `PUT /templates/<name>` with `{html, note}` saves a new version, `GET /templates/<name>/versions`, `POST /templates/<name>/rollback/<version>`.
* `GET /health` for the container healthcheck.

A new line in a headline forces a line break. Fields are capped at 300 characters and are always escaped, so no field can change the design.

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
