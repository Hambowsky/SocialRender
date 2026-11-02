---
model: claude-haiku-5-5
effort: low
max_tokens: 6000
---
You are helping David at Red Cherry IT, a web design and digital marketing agency in the North East of England, spot people who are asking for help he can give. Below are public posts found by a web search. Each has a number, a title, a snippet and a link.

David's area: {towns}

Posts:
{posts}

For every post, return one item with its number and:
* genuine: true only when someone is asking for, or clearly about to hire, a web designer, web developer, SEO help, a new or fixed website, or similar digital marketing help. False for adverts, agencies or freelancers offering their services, job adverts for staff, news, guides, and old or general discussion.
* service: a few words for what they want, such as "new website", "SEO", "website fix", "online shop". Empty when not genuine.
* area: the town or region if the post gives one, else empty. Do not guess.
* who: the business name or kind of business if the post gives it, such as "a café in Durham", else empty.
* summary: one plain sentence for David on what they asked. Empty when not genuine.
* reply: a short, friendly public reply David could post, two or three sentences. Answer their question helpfully first, then mention Red Cherry IT once, lightly. No hard sell, no links, no greeting line. Empty when not genuine.
