# Red Cherry IT Social and Content Tool

## What this is
A small, resilient marketing tool for Red Cherry IT (redcherryit.com), a UK web design and digital marketing agency run by David, a sole trader. It turns editable HTML/CSS templates into PNG images, writes social posts and articles with Claude, queues posts in Buffer, and later sends email via Resend and renders simple motion clips.

Hermes (David's agent, running on this same VPS in a separate project) handles admin only: deciding what is needed and when, and calling this tool. This tool does the heavy lifting. Keep it independent of Hermes.

## Design principles
* Mostly plain deterministic code. Claude is called only for judgment and writing (headlines, subtitles, captions, articles, brand voice checks).
* Rendering, validation, queueing, retries, logging and posting are normal code with no AI cost.
* Modular: separate modules with separate endpoints, so one failing does not take down the rest.
* Resilient: jobs are idempotent (a retry must never post twice), failures are logged, and renders run one at a time.
* Human approval before anything public (articles, social posts, emails). Auto posting is a later switch, off by default.
* Spend caps on every Claude call and any paid media API, so a bug or loop cannot run up a bill.
* Keep it small. Do not add dependencies or abstractions that are not needed yet.

## Build order
1. Template renderer (HTML/CSS to PNG) with a simple editor and live preview
2. Claude copywriting (headline, subtitle, caption) using editable prompts
3. Buffer scheduling
4. Articles (draft, review queue, publish, then matching social posts)
5. Later: Resend email, research module, simple motion clips (HTML animation to MP4 via headless Chromium and ffmpeg)

## Renderer
* Headless Chromium (Playwright) with one persistent browser instance reused across jobs.
* Output 1080x1080 PNG for social posts. Template element to screenshot is `.post`.
* Install the Archivo font on the server so renders match the design and do not depend on Google Fonts.
* Templates are plain HTML files in a templates folder. The agent or user can only change text fields, so the brand cannot break.
* Template fields so far: `headline`, `highlight_word` (shown in brand red), `subtitle`, `tag` (top right label), `footer_left`, `footer_right`.
* Validate text length before rendering. If a headline is too long, return an error so the caller shortens it. Do not render overlapping text.
* Starter template: a reference `social-post.html` exists (David has it). Replace the placeholder SVG cherry with the real Red Cherry IT logo file.
* Plan several templates (quote card, stat card, tip card) and rotate them for variety.
* Delete old rendered files after posting to save disk.

## Brand
* Red: #b5333f
* Logo grey: #a89c9c
* Ink (text): #1a1a1a
* Body grey: #444
* Heading font: Archivo, weight 900. Body: Archivo 400 and 500.
* Layout: logo top left, small uppercase "MARKETING GUIDE" style tag top right, short red accent bar, large headline with one highlighted word in red, grey subtitle, thin black rule, footer with bold left text and red website on the right.

## Prompts section
Prompts live as editable files (not in code), with placeholders such as `{topic}`, `{keyword}`, `{audience}`, `{sources}`.
* Shared brand voice prompt, added to every job
* Article structure prompt (David has a structure and will paste it in)
* Social post prompt
* Caption prompt
* Keep saved versions so changes can be rolled back, and add a test run option that shows output without publishing or queueing.

## Claude usage
* Use the Anthropic API with its own API key from the Console, billed per token. This is separate from David's Pro subscription, which is only for building the tool.
* Sonnet 5.5 for articles and quality copy. Haiku 5.5 for routine captions and routing. Opus 5.5 only if quality demands it.
* Model IDs: claude-sonnet-5-5, claude-haiku-5-5, claude-opus-5-5.
* Do not set ANTHROPIC_API_KEY in the shell while building with Claude Code on the Pro subscription, or usage will bill to the API instead.

## Buffer
* Buffer has a GraphQL API at https://api.buffer.com (docs: https://developers.buffer.com/guides/introduction.md).
* The docs say it can schedule text and image posts and fetch channels, posts and organisations. They do not mention video. Check video support and whether David's plan includes API access before relying on it.
* Fallback for video: save the file and notify David to post it manually.

## Articles
* Flow: topic and keyword in, Claude drafts using the structure prompt, rule checks (word count, required headings, sources present), review queue, approve, publish, then Claude writes matching social posts and queues them in Buffer.
* Always include sources in research and flag claims without one.
* Publishing target is still to be confirmed (WordPress REST API or static site files).

## Later: email via Resend
* Build emails from templates, send a test to David first, then send to a list.
* UK PECR and GDPR: consent or a valid basis, working unsubscribe link, suppression list, care with sole traders (treated as individuals).
* Set up SPF, DKIM and use a separate sending subdomain.

## Later: motion
* HTML/CSS animated templates played in headless Chromium, frames captured, stitched into MP4 with ffmpeg. Short clips (10 to 15 seconds), 24 or 30 fps, one render at a time.
* Paid AI video (Veo, Kling) is optional and only behind a spend cap.

## API layer
* Expose the tool over a simple authenticated HTTP API (API key required) so Hermes or any script can call it. Wrap it as an MCP server or function calling definition to match whatever Hermes uses.
* Example call: render with template, headline, highlight_word, subtitle, returning a PNG file path or URL.

## Server and safety
* Runs on David's Oracle VPS, alongside Hermes. Keep this project in its own folder, ideally under a separate Linux user, and never read or change Hermes files or secrets.
* Check RAM before heavy work. With 1GB add swap and run one render at a time.
* Keep API keys in environment variables or a .env file that is not committed.
* Use tmux so long Claude Code sessions survive disconnects.

## Cost expectations (rough)
* Templated PNGs: effectively free, plus a few pence of tokens per post.
* Articles on Sonnet 5.5: pence to under a pound each, more with heavy research.
* Total running cost should stay low: VPS already paid for, tokens, optional Resend and Buffer plans.

## Style rules for any writing produced for David
* Direct, concise, plain language.
* Never use dashes (em dashes or hyphens used as punctuation) in copy, articles, captions or messages.
* Use UK English.

## Open questions
* Article structure prompt (David to paste in)
* Where articles are published
* Sample of David's tone or example articles
* Whether Buffer API access and video are available on his plan
* How Hermes calls tools (MCP, function calling or plain HTTP)
* VPS specs (run `free -h` and `uname -m`)
