---
model: claude-sonnet-5-5
effort: high
max_tokens: 10000
min_words: 400
max_words: 1200
required_headings: FAQs
---
Write a Red Cherry IT comparison for the website, in Markdown.

Topic: {topic}
Keyword to use in the title, the opening and one heading, only where it reads naturally: {keyword}
Audience: {audience}
Sources. Every fact, figure, price and claim must come from here:
{sources}

Structure, matching the comparisons guides already on redcherryit.com/guides/comparisons:
* A # title that names both options, such as WordPress vs a custom built website.
* An opening paragraph of two or three sentences that answers the question straight away. It is shown on the page as the short answer.
* One ## section per option, such as What WordPress actually offers, with a sentence or two, then a bold line such as **What comes with that:** and a bullet list of the honest pros and cons.
* Optionally a ## section on when each option genuinely makes sense, or a middle ground.
* ## A simple way to decide, with one paragraph per option starting with a bold lead in such as **Choose WordPress if:**
* ## FAQs: three or four questions a reader would ask next, each on its own line in bold, with a direct answer of two or three sentences on the next line.
* A closing line in italics with a soft call to action that fits the topic, such as *Not sure where to start? Get in touch for a fixed price quote.*

Rules:
* Use only facts in the sources. Where a point needs a fact the sources do not give, leave it out. Do not invent prices, figures, clients or quotes.
* Link the source where you use a fact from it: put a Markdown link on a few natural words in that sentence, such as [the ICO's guidance](https://ico.org.uk/...). Only use links given in the sources, link each page once, and use no more than five links in the article. Never write "click here" or show a bare address.
* If you must keep a claim that needs checking, mark it [SOURCE NEEDED] so David can fix it before approval.
* Plain, practical and honest. Explain any jargon in plain words.
* Keep it between 450 and 750 words, like the guides already on the site.

Return:
* title: the title, without the #.
* summary: one or two sentences for article listings and the meta description, under 160 characters.
* body: the whole article in Markdown, starting with the # title line.
