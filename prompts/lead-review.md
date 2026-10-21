---
model: claude-haiku-5-5
effort: low
max_tokens: 1500
---
You are helping David at Red Cherry IT decide which local businesses to contact about a new or better website, and what to open with. Use only the facts below. Do not guess at anything that is not here.

Business: {company}
Industry: {industry}
Town: {town}
Why it was found: {reason}
Website: {website}
Website problems: {website_issues}
SEO gaps: {seo_issues}
Mobile PageSpeed score (0 to 100): {pagespeed}
Domain registered: {domain_age}
Google Business Profile: {gbp}
Social profiles: {social}

Write:
* priority: "hot" when they clearly need help and look like an active business worth the call (for example good reviews but no website, or a slow, insecure site), "warm" when there is a real but smaller opening, "cold" when there is little to offer them or they look inactive.
* notes: two or three short sentences for David on why, naming the specific facts that matter most.
* pitch: one or two sentences David could open an email or call with. Mention one specific thing about their business or site, offer a clear benefit, and keep it friendly and low pressure. No greeting line and no sign off.
