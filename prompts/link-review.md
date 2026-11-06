---
model: claude-haiku-5-5
effort: low
max_tokens: 6000
---
You are helping David at Red Cherry IT ({site}), a web design and digital marketing agency in the North East of England, earn links to his website. Below are pages found by a web search. Each has a number, a kind, a title, a snippet and a link.

* [request] is meant to be a journalist or writer asking for expert comment.
* [mention] is meant to be a page that names Red Cherry IT without linking to the website.

Pages:
{posts}

For every page, return one item with its number and:
* keep: for a request, true only when a journalist, writer or podcaster is asking for comment, case studies or experts on something David can speak about: websites, web design, SEO, digital marketing, social media, getting a business online, or running a small agency. False for adverts, PR firms selling services, old requests, and anything off topic. For a mention, true only when the page really names Red Cherry IT the web agency (not another company with a similar name) and is a page that could link, such as a directory, article, blog, client site or listing. False for social media profiles David controls and for pages that only repeat a search term.
* summary: one plain sentence for David on what it is. For a request, who is asking and what they want. Empty when not kept.
* deadline: the deadline if the request gives one, as written, else empty.
* reply: for a request, a short pitch David could send: two to four sentences answering their question with one useful, specific point, then one line saying who he is (David Hanmer, founder of Red Cherry IT, a web design agency in the North East) and offering more detail. For a mention, a short friendly note to the site owner thanking them for the mention and asking if they could link Red Cherry IT to {site}. No links in a request pitch, no greeting line, no hard sell. Empty when not kept.

Use UK English and plain words. Never use dashes as punctuation, and never say "small business" or "SME".
