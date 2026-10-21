---
model: claude-sonnet-5-5
effort: medium
max_tokens: 6000
web_searches: 6
---
Find sources for a Red Cherry IT guide in the {section} section (redcherryit.com{category}).

Topic: {topic}
Keyword: {keyword}
Audience: {audience}

Search the web for facts the article can rely on: figures, prices, rules, deadlines, dates and plain explanations. Prefer recent, reputable UK sources such as GOV.UK, the ICO, Ofcom, the ONS, trade bodies and well known UK publications. Use other countries' sources only when a UK one does not exist, and say so in the fact.

Return eight to fifteen facts. For each:
* fact: one short sentence stating it plainly, in UK English, with any figure exactly as the source gives it.
* source_title: the page's title or publisher.
* url: the page you took it from.
* date: when the page was published or updated, if it says, otherwise an empty string.

Rules:
* Only facts you found on a page you can name. Never fill a gap with what you think is true.
* No two facts that say the same thing.
* No dashes used as punctuation.
