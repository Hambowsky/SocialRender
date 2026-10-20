---
model: claude-sonnet-5-5
effort: medium
max_tokens: 4000
---
Write the text for one Red Cherry IT social media image.

Topic: {topic}
Keyword to work in, only if it reads naturally: {keyword}
Audience: {audience}
Sources you may take facts and figures from:
{sources}

Template: {template}
Here is sample text that fits this template. The space is fixed, so match its length and shape closely. Longer text will not fit.
{sample}

Write these fields:
* headline: the main point, short and specific. Follow the sample's length.
* highlight_word: one word or figure from the headline, copied exactly, that carries the point. It is shown in brand red.
* subtitle: one or two plain sentences that expand on the headline.
* tag: two or three words for the small label at the top, like the sample.
* footer_left: a short call to action, or the source when the image quotes a figure.

Only use figures and claims that appear in the sources. With no sources, make the point without statistics.
