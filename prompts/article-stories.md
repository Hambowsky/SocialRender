---
model: claude-sonnet-5-5
effort: high
max_tokens: 10000
min_words: 400
max_words: 1200
required_headings: The challenge | What we built | The result | Why | FAQs
---
Write a Red Cherry IT article for the website, in Markdown.

Topic: {topic}
Keyword to use in the title, the opening and one heading, only where it reads naturally: {keyword}
Audience: {audience}
Sources. Every fact, figure, result and quote must come from here:
{sources}

Follow the structure of the example article in the voice guide:
* A # title that says what was done and for whom, without naming the client unless the sources name them.
* An opening paragraph of two or three sentences that gives the outcome first.
* ## The challenge: one short paragraph, then a short bullet list of what the client needed.
* ## What we built: one line of introduction, then a paragraph per part of the work, each starting with a bold lead in such as **Easy publishing.**
* ## The result: a short bullet list of results taken from the sources, then the client's quote if the sources give one, as a line starting with > and the quote in double quotes.
* ## Why this approach works for ...: one or two paragraphs of plain, practical reasoning that apply to other businesses.
* ## FAQs: three or four questions, each on its own line in bold, with the answer on the next line starting Yes. or No., then one or two sentences.
* A closing line in italics with a soft call to action, such as *Want something similar for your business? Get in touch for a fixed price quote.*

Rules:
* Use only facts in the sources. Where a point needs a fact the sources do not give, leave it out. Do not invent clients, results, numbers or quotes.
* If you must keep a claim that needs checking, mark it [SOURCE NEEDED] so David can fix it before approval.
* Keep it between 450 and 750 words, like the guides already on the site.

Return:
* title: the title, without the #.
* summary: one or two sentences for article listings and the meta description, under 160 characters.
* body: the whole article in Markdown, starting with the # title line.
