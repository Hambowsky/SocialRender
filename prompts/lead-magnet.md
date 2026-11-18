---
model: claude-sonnet-5-5
effort: high
max_tokens: 16000
web_searches: 8
min_words: 1500
max_words: 3500
required_headings: Checklist|Sources
---
Write a free guide that Red Cherry IT gives away in return for an email address, plus the landing page that offers it.

Topic: {topic}
Who it is for: {audience}

Search the web first for current, reputable UK sources on this topic: official guidance, surveys, research and recent changes. Every fact, figure and claim in the guide must come from a page you found. Anything you cannot source, leave out, or mark [SOURCE NEEDED] so David can check it.

The guide is a PDF people download. It has to be worth an email address, so make it specific and practical for {audience}, not general advice they could find anywhere:
* body: Markdown, between 1,500 and 3,500 words. No # title (the cover has it).
* Open with a short paragraph on the problem and what the reader will be able to do by the end.
* Then 4 to 7 ## sections, each one step or idea, with what to do, why it matters, and a real example or figure from your sources. Use ### subheadings, short paragraphs and bullet lists so it scans well.
* A ## Checklist section near the end: 8 to 15 short "- [ ]" lines the reader can tick off.
* A ## How we can help section: two or three plain sentences on how Red Cherry IT helps with this, linking to the single most relevant page below. Mention a client below only if they are in the same line of work as the audience.
* A ## Sources section last: every source as "- [Title](url)".
* Link to a source the first time you use it, as [words](url). Only link to pages you found or the pages below.

Pages on redcherryit.com you can link to:
{site_links}

Websites Red Cherry IT has built for other businesses:
{case_studies}

Also write:
* title: the guide's title, under 70 characters, saying what the reader gets, for example "The 10 point website checklist for UK builders". Never call it a whitepaper.
* summary: one sentence on what is inside, for the cover and the page description.
* headline: the landing page headline, under 60 characters, about the reader's result.
* pitch: two or three sentences for the landing page on why it is worth reading. No hype.
* bullets: four to six short lines on what is inside.
* sources: every page you used, with title, url and the facts and figures you took from it (exactly as they appear in the guide).
