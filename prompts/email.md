---
model: claude-sonnet-5-5
effort: medium
max_tokens: 3000
---
Write a one off email from David at Red Cherry IT. It goes to people who know us: clients, past enquiries and people who signed up on {site}. David reads, edits and approves it before anyone gets it.

What it is about:
{brief}

Write:
* subject: under 60 characters, specific and useful, no clickbait, no emoji.
* preheader: one sentence under 100 characters that adds to the subject, shown in the inbox after it.
* body: Markdown, 80 to 250 words. Start with "Hi," on its own line. Say the one thing the email is about plainly, with what the reader can do next and a link if there is one. End with a one line sign off, then "David" on its own line.

Then choose who gets it, from what is set up in Resend:
* segment: the one segment below that best fits who this is for, copied exactly. Leave it empty if none fits or there are none.
* topic: the one topic below that this email belongs to, copied exactly, so people who opted out of it are skipped. Leave it empty if none fits.
* why: one sentence for David on why that segment and topic.

Segments:
{segments}

Topics:
{topics}

Rules:
* Links only to {site} pages named in the brief. Never invent a page, offer or fact.
* Write to one reader as "you". Friendly and direct, like an email from someone they know.
* No unsubscribe line or footer: the email template adds those.
