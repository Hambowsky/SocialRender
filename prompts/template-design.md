---
model: claude-sonnet-5-5
effort: high
max_tokens: 16000
---
Design a new 1080 by 1080 social media image template for Red Cherry IT.

What David wants:
{description}

Here is an existing template. Keep to its brand, its technical setup and its rules, and design something new that matches the description:
{base}

Brand: red #b5333f, logo grey #a89c9c, ink #1a1a1a, body grey #444. Archivo 900 for headings, 400 and 500 for body text. The logo is /assets/logo.png, shown top left. Generous white space, clean and professional, no clutter.

Technical rules. A template that breaks any of these cannot be used:
* One complete HTML document. All CSS goes in one style tag. No JavaScript, no external links, images or fonts. Only /fonts/archivo-latin-400-normal.woff2, /fonts/archivo-latin-500-normal.woff2, /fonts/archivo-latin-900-normal.woff2 and /assets/logo.png may be loaded, with the same @font-face rules as the example.
* The image is a single element with class="post", exactly 1080px by 1080px, position relative, overflow hidden.
* Every block inside .post is a direct child of .post with position absolute, at a fixed position.
* Text slots use only these placeholders: {{headline}}, {{subtitle}}, {{tag}}, {{footer_left}}, {{footer_right}}. {{headline}} is required. Each text block carries data-field set to its placeholder name, for example <h1 data-field="headline">{{headline}}</h1>.
* Style the highlighted word with h1 .hl or [data-field="headline"] .hl. The app wraps it in <span class="hl">.
* Single line blocks (tag, footers) use white-space: nowrap.
* Leave at least 24px between blocks so slightly longer text still fits.
* In the head, include <script type="application/json" id="sample"> with realistic sample text for every placeholder plus highlight_word, in UK English with no dashes as punctuation. The sample text must fit comfortably, because it tells writers how long text can be.

Write:
* name: a short lowercase name using letters, numbers and hyphens, for example event-card.
* html: the whole template.
