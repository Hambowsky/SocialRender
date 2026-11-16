// Resend's webhook: bounces, spam complaints and unsubscribes go on the Do not email list, and opens and clicks
// are counted against the newsletter or email they came from. Signed by Resend (Svix), so nobody else can post here.
import crypto from 'node:crypto';
import { db } from './db.ts';
import { fail, RESEND_WEBHOOK_SECRET } from './config.ts';

export function verify(body: string, h: Record<string, string | string[] | undefined>, now = Date.now()) {
  if (!RESEND_WEBHOOK_SECRET) fail(503, 'RESEND_WEBHOOK_SECRET is not set');
  const [id, ts, sigs] = ['svix-id', 'svix-timestamp', 'svix-signature'].map(k => String(h[k] ?? ''));
  if (!id || !ts || Math.abs(now / 1000 - Number(ts)) > 300) fail(401, 'Stale or unsigned webhook');
  const key = Buffer.from(RESEND_WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const want = Buffer.from(crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64'));
  const ok = sigs.split(' ').some(s => { const got = Buffer.from(s.split(',')[1] ?? ''); return got.length === want.length && crypto.timingSafeEqual(got, want); });
  if (!ok) fail(401, 'Bad webhook signature');
  return id;
}

const suppress = (email: string, reason: string) =>
  email && db.prepare('INSERT INTO suppression (email, reason) VALUES (?, ?) ON CONFLICT DO NOTHING').run(email.trim().toLowerCase(), reason);

export function handle(id: string, e: { type: string; data: any }) {
  const d = e.data ?? {}, email = String(d.email ?? d.to?.[0] ?? '').toLowerCase();
  if (!Number(db.prepare('INSERT INTO email_events (id, type, broadcast_id, email, link) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
    .run(id, e.type, d.broadcast_id ?? '', email, d.click?.link ?? '').changes)) return { ok: true, duplicate: true };
  if (e.type === 'email.bounced' && d.bounce?.type === 'Permanent') suppress(email, 'bounced');
  if (e.type === 'email.complained') suppress(email, 'complained');
  if (e.type === 'contact.updated' && d.unsubscribed) suppress(email, 'unsubscribed');
  return { ok: true };
}

// Each counted once per person: someone who opens twice is one open.
export function stats(broadcastId: string | null) {
  if (!broadcastId) return null;
  const rows = db.prepare('SELECT type, COUNT(DISTINCT email) AS n FROM email_events WHERE broadcast_id = ? GROUP BY type').all(broadcastId) as { type: string; n: number }[];
  const c = (t: string) => rows.find(r => r.type === `email.${t}`)?.n ?? 0;
  const links = db.prepare(`SELECT link, COUNT(DISTINCT email) AS n FROM email_events WHERE broadcast_id = ? AND type = 'email.clicked' GROUP BY link ORDER BY n DESC LIMIT 5`).all(broadcastId);
  return { delivered: c('delivered'), opened: c('opened'), clicked: c('clicked'), bounced: c('bounced'), complained: c('complained'), links };
}
