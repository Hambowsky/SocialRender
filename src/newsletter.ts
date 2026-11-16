// The monthly newsletter, and one off emails: Claude drafts them and picks the Resend segment and topic; David edits,
// sends himself a test, approves, and then presses Send, which hands it to Resend as a broadcast.
import { db } from './db.ts';
import { fail, NEWS_FROM, NEWS_TEST_TO, PUBLIC_URL, RESEND_API_KEY, SITE_URL, SMTP_FROM } from './config.ts';
import { runPrompt } from './copy.ts';
import { caseStudies, unsubscribeUrl } from './outreach.ts';
import { esc, toHtml } from './markdown.ts';
import { audience, resend, sendEmail } from './contacts.ts';

type Newsletter = { id: number; kind: 'monthly' | 'oneoff'; subject: string; preheader: string; body: string; focus: string; status: string; cost_gbp: number;
  segment_id: string; topic_id: string; pick_note: string; broadcast_id: string | null; sent_at: string | null; created_at: string; updated_at: string; approved_at: string | null };

export const list = () => db.prepare('SELECT id, kind, subject, status, created_at, approved_at, sent_at FROM newsletters ORDER BY id DESC LIMIT 50').all();
export const get = (id: number) => (db.prepare('SELECT * FROM newsletters WHERE id = ?').get(id) as Newsletter | undefined) ?? fail(404, `There is no newsletter ${id}`);

// Resend's segments and topics, for Claude to choose from. Without a key it drafts anyway and David picks later.
async function choices() {
  if (!RESEND_API_KEY) return { segments: [], topics: [] } as Awaited<ReturnType<typeof audience>>;
  return audience().catch(() => ({ segments: [], topics: [], members: {} }));
}
const byName = <T extends { id: string; name: string }>(list: T[], name: string) => list.find(x => x.name.trim().toLowerCase() === name.trim().toLowerCase())?.id ?? '';

export async function draft(input: { focus?: string; kind?: 'monthly' | 'oneoff' } = {}) {
  const now = new Date(), kind = input.kind ?? 'monthly';
  const aud = await choices();
  const pickVars = {
    segments: aud.segments.map(s => s.name).join('\n') || 'none yet',
    topics: aud.topics.map(t => `${t.name}${t.description ? `: ${t.description}` : ''}`).join('\n') || 'none yet',
  };
  const fresh = db.prepare(`SELECT category, slug, title, summary FROM articles WHERE status = 'published' AND published_at >= datetime('now', '-45 days') ORDER BY published_at DESC LIMIT 6`).all() as { category: string; slug: string; title: string; summary: string }[];
  const articles = fresh.length ? fresh : (await (await import('./articles.ts')).siteGuides()).slice(-4); // nothing new: the newest guides on the site
  const stories = caseStudies() as { client: string; industry: string; blurb: string }[];
  const story = stories.at(now.getMonth() % Math.max(stories.length, 1)); // a different client each month
  const r = await runPrompt(kind === 'oneoff' ? 'email' : 'newsletter', {
    ...pickVars, brief: input.focus?.trim() ?? '',
    month: now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }), site: SITE_URL, focus: input.focus?.trim() || 'nothing in particular',
    articles: articles.map(a => `${a.title}: ${a.summary} (${SITE_URL}${a.category}${a.slug})`).join('\n') || 'none',
    case_study: story ? `${story.client} (${story.industry}): ${story.blurb}` : 'none',
  }, { job: 'newsletter:draft' });
  const o = r.output as { subject: string; preheader: string; body: string; segment: string; topic: string; why: string };
  const id = db.prepare('INSERT INTO newsletters (kind, subject, preheader, body, focus, cost_gbp, segment_id, topic_id, pick_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(kind, o.subject, o.preheader, o.body, input.focus ?? '', r.cost_gbp ?? 0, byName(aud.segments, o.segment), byName(aud.topics, o.topic), o.why).lastInsertRowid;
  return get(Number(id));
}

export function update(id: number, body: { subject?: string; preheader?: string; body?: string; segment_id?: string; topic_id?: string }) {
  if (get(id).status !== 'draft') fail(409, 'Only a draft can be edited. Move it back to draft first.');
  db.prepare(`UPDATE newsletters SET subject = coalesce(?, subject), preheader = coalesce(?, preheader), body = coalesce(?, body),
    segment_id = coalesce(?, segment_id), topic_id = coalesce(?, topic_id), updated_at = datetime('now') WHERE id = ?`)
    .run(body.subject ?? null, body.preheader ?? null, body.body ?? null, body.segment_id ?? null, body.topic_id ?? null, id);
  return get(id);
}

const MOVES: Record<string, [string[], string]> = { approve: [['draft'], 'approved'], reject: [['draft', 'approved', 'sending'], 'rejected'], reopen: [['approved', 'rejected'], 'draft'] };
export function move(id: number, act: keyof typeof MOVES) {
  const [from, to] = MOVES[act], n = get(id);
  if (!from.includes(n.status)) fail(409, `This newsletter is ${n.status}, so it cannot be ${act === 'reopen' ? 'moved back to draft' : `${act}d`}`);
  db.prepare(`UPDATE newsletters SET status = ?, approved_at = CASE ? WHEN 'approved' THEN datetime('now') ELSE approved_at END, updated_at = datetime('now') WHERE id = ?`).run(to, to, id);
  return get(id);
}

// The email itself: tables and inline styles, because that is what email apps understand.
const RED = '#b5333f', INK = '#1a1a1a', BODY = '#444444';
const styled = (html: string) => html
  .replace(/<h2>/g, `<h2 style="margin:28px 0 8px;font-size:20px;line-height:1.3;font-weight:800;color:${INK}">`)
  .replace(/<h3>/g, `<h3 style="margin:20px 0 6px;font-size:17px;font-weight:700;color:${INK}">`)
  .replace(/<p>/g, `<p style="margin:0 0 14px">`)
  .replace(/<ul>/g, '<ul style="margin:0 0 14px;padding-left:20px">').replace(/<ol>/g, '<ol style="margin:0 0 14px;padding-left:20px">')
  .replace(/<li>/g, '<li style="margin:0 0 8px">')
  .replace(/<a href="([^"]+)"[^>]*>/g, `<a href="$1" style="color:${RED};font-weight:700">`);

// Resend fills in each person's own unsubscribe link when it sends a broadcast.
const RESEND_UNSUB = '{{{RESEND_UNSUBSCRIBE_URL}}}';
export function html(n: Pick<Newsletter, 'subject' | 'preheader' | 'body'>, to: string, unsub = unsubscribeUrl(to)) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(n.subject)}</title></head>
<body style="margin:0;padding:0;background:#f6f4f3">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(n.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f4f3"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px">
<tr><td style="padding:28px 32px 0"><a href="${SITE_URL}"><img src="${PUBLIC_URL}/assets/logo.png" alt="Red Cherry IT" width="159" height="30" style="display:block;border:0"></a>
<div style="width:48px;height:4px;background:${RED};margin:22px 0 0"></div></td></tr>
<tr><td style="padding:20px 32px 28px;font:16px/1.6 Arial,Helvetica,sans-serif;color:${BODY}">
${styled(toHtml(n.body))}
</td></tr>
<tr><td style="padding:20px 32px 28px;border-top:1px solid #ebe6e5;font:13px/1.5 Arial,Helvetica,sans-serif;color:#8a8282">
Red Cherry IT · <a href="${SITE_URL}" style="color:${RED}">redcherryit.com</a><br>
You are getting this because you work with us, got in touch, or signed up on our website. <a href="${esc(unsub)}" style="color:#8a8282">Unsubscribe</a>
</td></tr></table></td></tr></table></body></html>`;
}

export const text = (n: Pick<Newsletter, 'body'>, to: string, unsub = unsubscribeUrl(to)) => `${n.body.replace(/^#+\s*/gm, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)').trim()}

Red Cherry IT · redcherryit.com
Unsubscribe: ${unsub}
`;

export function message(n: Newsletter, to: string, subject = n.subject) {
  const unsub = unsubscribeUrl(to);
  return { to, subject, html: html(n, to), text: text(n, to), headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } };
}

// A copy to David only, marked as a test. Nothing is recorded against any contact.
export async function test(id: number) {
  const to = NEWS_TEST_TO || SMTP_FROM.match(/<([^>]+)>/)?.[1] || SMTP_FROM;
  if (!to) fail(503, 'Set NEWS_TEST_TO (or SMTP_FROM) so the test knows where to go');
  await sendEmail(message(get(id), to, `[Test] ${get(id).subject}`));
  return { sent_to: to };
}

// Sends an approved email to its Resend segment, skipping anyone who opted out of its topic. Anyone on the studio's
// Do not email list is marked unsubscribed in Resend first. Status goes to sending before Resend is asked, so a
// retry after a crash stops instead of sending twice.
export async function send(id: number) {
  const n = get(id);
  if (n.status !== 'approved') fail(409, n.status === 'sending' ? 'This was already handed to Resend. Check Broadcasts in Resend before trying again.' : 'Approve it before sending');
  if (!n.segment_id) fail(400, 'Pick a segment to send it to');
  const aud = await audience();
  if (!aud.segments.some(s => s.id === n.segment_id)) fail(400, 'That segment is no longer in Resend. Pick another.');
  const blocked = new Set((db.prepare('SELECT email FROM suppression').all() as { email: string }[]).map(r => r.email.toLowerCase()));
  for (const [email, segs] of Object.entries(aud.members)) if (segs.includes(n.segment_id) && blocked.has(email))
    await resend(`/contacts/${encodeURIComponent(email)}`, { method: 'PATCH', body: { unsubscribed: true } });
  if (!Number(db.prepare(`UPDATE newsletters SET status = 'sending', updated_at = datetime('now') WHERE id = ? AND status = 'approved'`).run(id).changes)) fail(409, 'This is already being sent');
  try {
    const b = await resend('/broadcasts', { method: 'POST', body: { segment_id: n.segment_id, topic_id: n.topic_id || undefined, from: NEWS_FROM, subject: n.subject,
      html: html(n, '', RESEND_UNSUB), text: text(n, '', RESEND_UNSUB), name: `${n.kind === 'oneoff' ? 'Email' : 'Newsletter'} ${n.id}: ${n.subject}`, send: true } });
    db.prepare(`UPDATE newsletters SET status = 'sent', broadcast_id = ?, sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(b.id ?? '', id);
  } catch (e: any) {
    if (e.resendStatus >= 400 && e.resendStatus < 500) db.prepare(`UPDATE newsletters SET status = 'approved' WHERE id = ?`).run(id); // Resend refused it, so nothing went out
    throw e;
  }
  return get(id);
}
