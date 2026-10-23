// Reads David's inbox over IMAP every 15 minutes for answers to outreach emails. A reply marks the lead as replied;
// a bounce marks the email and lead as bounced and puts the address on the do not email list. Nothing is changed in the mailbox.
import { ImapFlow } from 'imapflow';
import { db } from './db.ts';
import { IMAP_HOST, IMAP_PASS, IMAP_PORT, IMAP_USER } from './config.ts';
import { suppress } from './outreach.ts';

type State = { validity?: string; uid?: number; checked_at?: string; error?: string };
export const inboxState = () => JSON.parse((db.prepare(`SELECT value FROM settings WHERE key = 'imap'`).get() as { value: string } | undefined)?.value ?? '{}') as State;
const saveState = (s: State) => db.prepare(`INSERT INTO settings (key, value) VALUES ('imap', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(s));

const note = (leadId: number, text: string) => db.prepare(`INSERT INTO lead_activity (lead_id, kind, text) VALUES (?, 'note', ?)`).run(leadId, text);

function parse(raw: string) {
  const split = raw.search(/\r?\n\r?\n/);
  const head = (split < 0 ? raw : raw.slice(0, split)).replace(/\r?\n[ \t]+/g, ' ');
  const header = (name: string) => head.match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'im'))?.[1].trim() ?? '';
  return { header, body: split < 0 ? '' : raw.slice(split) };
}
const ourIds = (text: string) => [...text.matchAll(/<outreach-(\d+)-[0-9a-f]+@[^>\s]+>/g)].map(m => Number(m[1]));
const address = (from: string) => (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();

type Sent = { id: number; lead_id: number | null; to_email: string };
const sentEmail = (where: string, value: string | number) =>
  db.prepare(`SELECT id, lead_id, to_email FROM emails WHERE ${where} AND status IN ('sent', 'check_sent', 'bounced') ORDER BY id DESC LIMIT 1`).get(value) as Sent | undefined;

// What one message in the inbox means for outreach, and the change it makes.
export function handleMessage(raw: string): 'reply' | 'bounce' | 'ignored' {
  const { header, body } = parse(raw);
  const from = address(header('From'));
  const bounce = /mailer-daemon|postmaster/i.test(from) || /report-type=["']?delivery-status/i.test(header('Content-Type'));
  if (bounce) {
    // Only a permanent failure counts: "delayed" notices (status 4.x.x) are left alone.
    if (!/^Action:\s*failed/im.test(body) && !/^Status:\s*5\./im.test(body) && !/(user unknown|does not exist|no such user|address rejected)/i.test(body)) return 'ignored';
    const byId = ourIds(body).map(id => sentEmail('id = ?', id)).find(Boolean);
    const recipient = body.match(/^Final-Recipient:\s*rfc822;\s*<?([^>\s]+)>?/im)?.[1].toLowerCase();
    const e = byId ?? (recipient ? sentEmail('to_email = ?', recipient) : undefined);
    if (!e) return 'ignored';
    db.prepare(`UPDATE emails SET status = 'bounced' WHERE id = ?`).run(e.id);
    suppress([e.to_email], 'bounced');
    if (e.lead_id) {
      db.prepare(`UPDATE leads SET status = 'bounced', updated_at = datetime('now') WHERE id = ? AND status IN ('new', 'contacted')`).run(e.lead_id);
      note(e.lead_id, `Email to ${e.to_email} bounced`);
    }
    return 'bounce';
  }
  // Out of office and other automatic answers are not a reply from the business.
  if (/auto-(replied|generated)/i.test(header('Auto-Submitted')) || header('X-Autoreply') || header('X-Autorespond') || /^(automatic reply|auto(matic)?[ :]|out of (the )?office)/i.test(header('Subject')))
    return 'ignored';
  const e = ourIds(`${header('In-Reply-To')} ${header('References')}`).map(id => sentEmail('id = ?', id)).find(Boolean) ?? sentEmail('to_email = ?', from);
  if (!e?.lead_id) return 'ignored';
  db.prepare(`UPDATE leads SET status = 'replied', updated_at = datetime('now') WHERE id = ? AND status IN ('new', 'contacted', 'bounced')`).run(e.lead_id);
  note(e.lead_id, `Replied from ${from}: ${header('Subject') || '(no subject)'}`);
  return 'reply';
}

// Logs in and opens the inbox, to prove the settings, without reading anything.
export async function testInbox() {
  if (!IMAP_HOST) return 'not set up (IMAP_HOST is blank)';
  const client = new ImapFlow({ host: IMAP_HOST, port: IMAP_PORT, secure: IMAP_PORT === 993, auth: { user: IMAP_USER, pass: IMAP_PASS }, logger: false });
  client.on('error', () => {});
  try {
    await client.connect();
    await client.mailboxOpen('INBOX', { readOnly: true });
    await client.logout();
    return 'connected';
  } catch (err) {
    client.close();
    return `failed: ${(err as Error).message}`;
  }
}

// New messages since the last check. The first check goes back to the day of the oldest email sent.
let checking = false;
export async function checkInbox() {
  if (checking || !IMAP_HOST) return;
  const sentSince = (db.prepare(`SELECT MIN(sent_at) AS d FROM emails WHERE sent_at IS NOT NULL`).get() as { d: string | null }).d;
  if (!sentSince) return; // nothing sent yet, so nothing to look for
  checking = true;
  const state = inboxState();
  const client = new ImapFlow({ host: IMAP_HOST, port: IMAP_PORT, secure: IMAP_PORT === 993, auth: { user: IMAP_USER, pass: IMAP_PASS }, logger: false });
  client.on('error', () => {}); // a dropped connection also rejects the call in progress, which is caught below
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      const box = client.mailbox as { uidValidity: bigint };
      const fresh = state.validity !== String(box.uidValidity);
      const uids = fresh ? (await client.search({ since: new Date(sentSince.slice(0, 10)) }, { uid: true })) || []
        : (await client.search({ uid: `${(state.uid ?? 0) + 1}:*` }, { uid: true })) || [];
      let last = fresh ? 0 : state.uid ?? 0;
      for (const uid of uids.filter(u => u > last).sort((a, b) => a - b)) {
        const msg = await client.fetchOne(String(uid), { uid: true, source: { maxLength: 300_000 } }, { uid: true });
        if (msg && msg.source) handleMessage(msg.source.toString('utf8'));
        last = uid;
      }
      saveState({ validity: String(box.uidValidity), uid: last, checked_at: new Date().toISOString() });
    } finally { lock.release(); }
    await client.logout();
  } catch (err) {
    saveState({ ...state, checked_at: new Date().toISOString(), error: (err as Error).message });
    client.close();
  } finally { checking = false; }
}

export function startInbox() {
  void checkInbox();
  setInterval(() => void checkInbox(), 15 * 60_000).unref();
}
