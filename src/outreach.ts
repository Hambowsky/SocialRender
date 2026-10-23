// Sales outreach. Claude drafts an email to a lead, it waits for David's approval, and approved emails go out
// from his own mailbox one at a time, within a daily cap. An email is sent at most once: a row is claimed as
// "sending" before the SMTP call, and one whose result is unknown is never retried on its own.
// Every email has an unsubscribe link, and a suppression list is checked before drafting and before sending.
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { db } from './db.ts';
import { API_KEY, fail, OUTREACH_DAILY_CAP, OUTREACH_DELAY_SECONDS, OUTREACH_FOLLOW_UP_DAYS, PUBLIC_URL,
  SMTP_FROM, SMTP_HOST, SMTP_PASS, SMTP_PORT, SMTP_USER } from './config.ts';
import { lead } from './leads.ts';
import { runPrompt } from './copy.ts';

type Email = { id: number; lead_id: number | null; to_email: string; subject: string; body: string; status: string; error: string | null;
  message_id: string | null; created_at: string; approved_at: string | null; sent_at: string | null; follow_up_of: number | null };

const get = (id: number) => (db.prepare('SELECT * FROM emails WHERE id = ?').get(id) as Email | undefined) ?? fail(404, `There is no email ${id}`);
const norm = (email: string) => email.trim().toLowerCase();
const suppressed = (email: string) => !!db.prepare('SELECT 1 FROM suppression WHERE email = ?').get(norm(email));
const note = (leadId: number | null, text: string) => leadId && db.prepare(`INSERT INTO lead_activity (lead_id, kind, text) VALUES (?, 'note', ?)`).run(leadId, text);

// Claude's draft, waiting for approval. A lead has at most one open email, so asking twice gives back the same draft.
export async function draft(leadId: number) {
  const l = lead(leadId) as any;
  const open = db.prepare(`SELECT id FROM emails WHERE lead_id = ? AND status IN ('pending_approval', 'approved', 'sending')`).get(leadId) as { id: number } | undefined;
  if (open) return get(open.id);
  if (!l.email) fail(400, 'This lead has no email address');
  if (suppressed(l.email)) fail(409, `${l.email} is on the do not email list`);
  const before = db.prepare(`SELECT sent_at FROM emails WHERE to_email = ? AND status IN ('sent', 'check_sent') ORDER BY id DESC LIMIT 1`).get(norm(l.email)) as { sent_at: string } | undefined;
  if (before) fail(409, `${l.email} was already emailed on ${before.sent_at.slice(0, 10).split('-').reverse().join('/')}`);
  const a = l.analysis, g = a.gbp;
  const describe = (o: Record<string, unknown>) => Object.entries(o).map(([k, v]) => v === true ? k.replace(/_/g, ' ') : `${k.replace(/_/g, ' ')}: ${v}`).join(', ') || 'none';
  const r = await runPrompt('outreach-email', {
    company: l.company_name, contact: l.contact_name || 'not known', industry: l.industry, town: l.town, website: l.website_url || 'none',
    website_issues: describe(l.website_issues), seo_issues: describe(l.seo_issues), pagespeed: a.pagespeed ? String(a.pagespeed.score) : 'not checked',
    gbp: g ? `${g.rating ?? 'no'} stars from ${g.reviews ?? 0} reviews` : 'not found', notes: a.notes ?? l.lead_reason, pitch: a.pitch ?? 'none',
    case_studies: (caseStudies() as CaseStudy[]).map(c => `${c.client} (${c.industry}): ${c.blurb}`).join('\n') || 'none',
  }, { job: 'lead:email' });
  db.prepare(`INSERT INTO emails (lead_id, to_email, subject, body) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`).run(leadId, norm(l.email), r.output.subject, r.output.body);
  return get((db.prepare(`SELECT id FROM emails WHERE lead_id = ? AND status IN ('pending_approval', 'approved', 'sending')`).get(leadId) as { id: number }).id);
}

// Drafts for every new lead in a campaign that has an email address and no draft yet, one at a time.
// Stops at the first error that is not about the lead itself, such as the monthly Claude cap.
let drafting = false;
export async function draftCampaign(campaignId: number) {
  if (drafting) fail(409, 'Drafts are already being written. Wait for them to finish.');
  drafting = true;
  try {
    const todo = db.prepare(`SELECT l.id FROM leads l WHERE l.campaign_id = ? AND l.status = 'new' AND COALESCE(l.email, '') != ''
      AND NOT EXISTS (SELECT 1 FROM emails e WHERE e.lead_id = l.id AND e.status IN ('pending_approval', 'approved', 'sending'))
      AND NOT EXISTS (SELECT 1 FROM suppression s WHERE s.email = lower(trim(l.email)))
      AND NOT EXISTS (SELECT 1 FROM emails e WHERE e.to_email = lower(trim(l.email)) AND e.status IN ('sent', 'check_sent')) ORDER BY l.id`).all(campaignId) as { id: number }[];
    let drafted = 0, skipped = 0;
    for (const t of todo) {
      try { await draft(t.id); drafted++; } catch (err: any) {
        if (![400, 409].includes(err.statusCode)) return { drafted, skipped, error: err.message };
        skipped++;
      }
    }
    return { drafted, skipped };
  } finally { drafting = false; }
}

// First emails sent long enough ago with no answer: the lead is still only "contacted", and nothing else is open for it.
// Each first email gets one follow up at most; a rejected follow up is not offered again.
const DUE = `FROM emails e JOIN leads l ON l.id = e.lead_id WHERE e.follow_up_of IS NULL AND e.status = 'sent' AND l.status = 'contacted'
  AND e.sent_at <= datetime('now', ?) AND NOT EXISTS (SELECT 1 FROM emails f WHERE f.follow_up_of = e.id)
  AND NOT EXISTS (SELECT 1 FROM emails o WHERE o.lead_id = e.lead_id AND o.status IN ('pending_approval', 'approved', 'sending'))
  AND NOT EXISTS (SELECT 1 FROM suppression s WHERE s.email = e.to_email)`;
const since = () => `-${OUTREACH_FOLLOW_UP_DAYS} days`;
export const followUpsDue = () => (db.prepare(`SELECT COUNT(*) AS n ${DUE}`).get(since()) as { n: number }).n;

// A short second email for each one due, in the same thread as the first. Waits for approval like any other.
export async function draftFollowUps() {
  if (drafting) fail(409, 'Drafts are already being written. Wait for them to finish.');
  drafting = true;
  try {
    const due = db.prepare(`SELECT e.*, l.company_name, l.contact_name ${DUE} ORDER BY e.id`).all(since()) as (Email & { company_name: string; contact_name: string })[];
    let drafted = 0;
    for (const e of due) {
      try {
        const r = await runPrompt('outreach-follow-up', { company: e.company_name, contact: e.contact_name || 'not known',
          days: String(Math.round((Date.now() - Date.parse(`${e.sent_at}Z`)) / 86_400_000)), subject: e.subject, first_email: e.body }, { job: 'lead:follow-up' });
        drafted += Number(db.prepare(`INSERT INTO emails (lead_id, to_email, subject, body, follow_up_of) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
          .run(e.lead_id, e.to_email, /^re:/i.test(e.subject) ? e.subject : `Re: ${e.subject}`, r.output.body, e.id).changes);
      } catch (err: any) { return { drafted, error: err.message }; }
    }
    return { drafted };
  } finally { drafting = false; }
}

// Every draft waiting for approval, approved at once. They still go one at a time within the daily cap.
export function approveAll() {
  ready();
  const { changes } = db.prepare(`UPDATE emails SET status = 'approved', approved_at = datetime('now'), error = NULL WHERE status = 'pending_approval'`).run();
  void pump();
  return { approved: Number(changes) };
}

// Past clients. Claude picks one in the lead's line of business, if there is one, to mention in the email.
type CaseStudy = { client: string; industry: string; blurb: string };
export const caseStudies = () => db.prepare('SELECT * FROM case_studies ORDER BY client').all();
// Adds new clients and updates ones already there (matched by name).
export function saveCaseStudies(rows: CaseStudy[]) {
  const up = db.prepare(`INSERT INTO case_studies (client, industry, blurb) VALUES (?, ?, ?)
    ON CONFLICT (client) DO UPDATE SET industry = excluded.industry, blurb = excluded.blurb`);
  for (const r of rows) up.run(r.client.trim(), r.industry.trim(), r.blurb.trim());
  return { saved: rows.length };
}
export function deleteCaseStudy(id: number) {
  if (!db.prepare('DELETE FROM case_studies WHERE id = ?').run(id).changes) fail(404, `There is no case study ${id}`);
  return { deleted: id };
}

export function list() {
  return db.prepare(`SELECT e.*, l.company_name FROM emails e LEFT JOIN leads l ON l.id = e.lead_id
    WHERE e.status IN ('pending_approval', 'approved', 'sending', 'failed', 'check_sent') OR e.created_at > datetime('now', '-60 days') ORDER BY e.id DESC LIMIT 300`).all();
}

export function edit(id: number, change: { subject?: string; body?: string }) {
  const r = db.prepare(`UPDATE emails SET subject = COALESCE(?, subject), body = COALESCE(?, body) WHERE id = ? AND status = 'pending_approval'`)
    .run(change.subject ?? null, change.body ?? null, id);
  if (!r.changes) fail(409, `Email ${id} can only be changed while it waits for approval (it is ${get(id).status})`);
  return get(id);
}

export function approve(id: number) {
  ready();
  const r = db.prepare(`UPDATE emails SET status = 'approved', approved_at = datetime('now'), error = NULL WHERE id = ? AND status IN ('pending_approval', 'failed')`).run(id);
  if (!r.changes) fail(409, `Email ${id} cannot be approved now (it is ${get(id).status})`);
  void pump();
  return get(id);
}

export function reject(id: number) {
  const r = db.prepare(`UPDATE emails SET status = 'rejected' WHERE id = ? AND status IN ('pending_approval', 'approved', 'failed', 'check_sent')`).run(id);
  if (!r.changes) fail(409, `Email ${id} cannot be rejected now (it is ${get(id).status})`);
  return get(id);
}

// After a check_sent result David checks with the mail server or the recipient, and tells us it did go out.
export function markSent(id: number) {
  const e = get(id);
  if (!db.prepare(`UPDATE emails SET status = 'sent', sent_at = datetime('now') WHERE id = ? AND status = 'check_sent'`).run(id).changes)
    fail(409, `Email ${id} is not waiting to be checked (it is ${e.status})`);
  contacted(e);
  return get(id);
}

function ready() {
  if (!SMTP_HOST || !SMTP_FROM) fail(503, 'Set SMTP_HOST, SMTP_FROM and the mailbox login before sending');
  if (!PUBLIC_URL) fail(503, 'Set PUBLIC_URL first: every email needs a working unsubscribe link');
}

const transport = () => nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
  auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined, connectionTimeout: 20_000, socketTimeout: 60_000 });

// The link proves which address it is for without storing anything: a keyed hash of the address.
const unsubToken = (email: string) => crypto.createHmac('sha256', API_KEY).update(`unsubscribe:${norm(email)}`).digest('base64url').slice(0, 24);
export const unsubscribeUrl = (email: string) => `${PUBLIC_URL}/unsubscribe?${new URLSearchParams({ e: norm(email), t: unsubToken(email) })}`;

function message(to: string, subject: string, body: string) {
  const url = unsubscribeUrl(to);
  return { from: SMTP_FROM, to, subject,
    text: `${body.trim()}\n\nRed Cherry IT · redcherryit.com\nIf you would rather not hear from us again, unsubscribe here: ${url}\n`,
    headers: { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } };
}

// A copy to David's own address, so he sees exactly what the lead will get. Nothing is recorded.
export async function test(id: number) {
  ready();
  const e = get(id);
  const own = SMTP_FROM.match(/<([^>]+)>/)?.[1] ?? SMTP_FROM;
  await transport().sendMail(message(own, `[Test] ${e.subject}`, e.body));
  return { sent_to: own };
}

// Proves the mailbox settings work before any lead is drafted: one plain email to David's own address.
export async function testSettings() {
  ready();
  const own = SMTP_FROM.match(/<([^>]+)>/)?.[1] ?? SMTP_FROM;
  await transport().sendMail(message(own, '[Test] Your studio can send email', 'This is a test from the studio. Outreach emails will come from this address and look like this, with the unsubscribe line below.'))
    .catch((err: Error) => fail(502, `The mail server said: ${err.message}`));
  return own;
}

export function sentToday() {
  return (db.prepare(`SELECT COUNT(*) AS n FROM emails WHERE status IN ('sent', 'sending', 'check_sent') AND sent_at >= date('now')`).get() as { n: number }).n;
}

function contacted(e: Email) {
  if (!e.lead_id) return;
  db.prepare(`UPDATE leads SET status = 'contacted', updated_at = datetime('now') WHERE id = ? AND status = 'new'`).run(e.lead_id);
  note(e.lead_id, `Emailed ${e.to_email}: ${e.subject}`);
}

// Sends approved emails one at a time, oldest first, pausing between them and stopping at the daily cap.
// What is left over waits for the next run: on approval, on start, and every 15 minutes.
let pumping = false;
export async function pump() {
  if (pumping || !SMTP_HOST) return;
  pumping = true;
  try {
    for (;;) {
      if (sentToday() >= OUTREACH_DAILY_CAP) return;
      const e = db.prepare(`SELECT * FROM emails WHERE status = 'approved' ORDER BY approved_at, id LIMIT 1`).get() as Email | undefined;
      if (!e) return;
      if (suppressed(e.to_email)) { db.prepare(`UPDATE emails SET status = 'rejected', error = 'On the do not email list' WHERE id = ?`).run(e.id); continue; }
      // A follow up only goes while there has been no answer: a reply or bounce since it was drafted stops it.
      const first = e.follow_up_of ? get(e.follow_up_of) : null;
      if (first && (db.prepare('SELECT status FROM leads WHERE id = ?').get(e.lead_id) as { status: string } | undefined)?.status !== 'contacted') {
        db.prepare(`UPDATE emails SET status = 'rejected', error = 'They answered the first email, so the follow up was not sent' WHERE id = ?`).run(e.id); continue;
      }
      const messageId = `<outreach-${e.id}-${crypto.randomBytes(6).toString('hex')}@${(SMTP_FROM.match(/@([^>\s]+)/)?.[1] ?? 'redcherryit.com')}>`;
      if (!db.prepare(`UPDATE emails SET status = 'sending', sent_at = datetime('now'), message_id = ? WHERE id = ? AND status = 'approved'`).run(messageId, e.id).changes) continue;
      try {
        const thread = first?.message_id ? { inReplyTo: first.message_id, references: first.message_id } : {};
        await transport().sendMail({ ...message(e.to_email, e.subject, e.body), messageId, ...thread });
        db.prepare(`UPDATE emails SET status = 'sent' WHERE id = ?`).run(e.id);
        contacted(e);
      } catch (err: any) {
        // A clear refusal from the mail server means it was not sent. Anything else (a dropped connection) might have been.
        const refused = typeof err.responseCode === 'number' || ['EAUTH', 'ECONNECTION', 'EDNS', 'ESOCKET'].includes(err.code) && !err.response;
        db.prepare(`UPDATE emails SET status = ?, error = ?, sent_at = CASE WHEN ? THEN NULL ELSE sent_at END WHERE id = ?`)
          .run(refused ? 'failed' : 'check_sent', String(err.message).slice(0, 500), refused ? 1 : 0, e.id);
        if (refused && err.code === 'EAUTH') return; // the login is wrong, so the rest would fail too
      }
      await new Promise(r => setTimeout(r, OUTREACH_DELAY_SECONDS * 1000));
    }
  } finally { pumping = false; }
}

// Called on start: an email left "sending" by a restart may or may not have gone, so David decides.
export function startOutreach() {
  db.prepare(`UPDATE emails SET status = 'check_sent', error = 'The app restarted while sending' WHERE status = 'sending'`).run();
  void pump();
  setInterval(() => void pump(), 15 * 60_000).unref();
}

export function suppressionList() {
  return db.prepare('SELECT email, reason, created_at FROM suppression ORDER BY created_at DESC').all();
}

export function suppress(emails: string[], reason: string) {
  let added = 0;
  for (const raw of emails) {
    const email = norm(raw);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) continue;
    added += Number(db.prepare('INSERT INTO suppression (email, reason) VALUES (?, ?) ON CONFLICT DO NOTHING').run(email, reason).changes);
    db.prepare(`UPDATE emails SET status = 'rejected', error = 'On the do not email list' WHERE to_email = ? AND status IN ('pending_approval', 'approved')`).run(email);
  }
  return { added };
}

export function unsuppress(email: string) {
  if (!db.prepare('DELETE FROM suppression WHERE email = ?').run(norm(email)).changes) fail(404, `${email} is not on the list`);
  return { ok: true };
}

export function validLink(email: string, token: string) {
  const a = Buffer.from(unsubToken(email)), b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function unsubscribe(email: string, token: string) {
  if (!validLink(email, token)) fail(400, 'That unsubscribe link is not valid');
  suppress([email], 'unsubscribed');
  for (const { id } of db.prepare(`SELECT id FROM leads WHERE email = ? COLLATE NOCASE`).all(norm(email)) as { id: number }[]) {
    db.prepare(`UPDATE leads SET status = 'not_interested', updated_at = datetime('now') WHERE id = ? AND status NOT IN ('converted', 'archived')`).run(id);
    note(id, `${norm(email)} unsubscribed`);
  }
}
