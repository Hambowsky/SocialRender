---
model: claude-sonnet-5-5
effort: high
max_tokens: 40000
---
Change this Red Cherry IT template for one post only. The saved template is not changed.

The change David wants:
{change}

The template:
{html}

Keep everything else exactly as it is: the layout, the text blocks and their placeholders and data-field attributes, the sample script, the brand colours and fonts, and on .post its class, data-size, data-sizes and data-seconds attributes and any .post[data-size] rules.

How to add the change:
* Use HTML and CSS only. Draw things with CSS shapes or inline SVG. No JavaScript, and nothing loaded from outside the app.
* Put decorations in a new element that is a direct child of .post, with data-decor, aria-hidden="true", position absolute, inset 0 and pointer-events none. The layout check skips data-decor elements, so they may sit over or behind other blocks.
* Keep all text easy to read: decorations stay light, small or behind the text, and never cover the headline.
* If the template is animated, new animations must end: use a finite iteration count, never infinite, and fit them inside the clip length in data-seconds. If it is not animated, add no animation.
* Stay on brand: red #b5333f, logo grey #a89c9c, ink #1a1a1a, plus white and soft tints of these, unless the change asks for other colours.

Write:
* html: the whole changed template.
