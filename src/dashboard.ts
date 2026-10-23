// The two dashboards: plain counts from the tables, so they cost nothing to load.
// "Needs you" lists what is waiting on David; the rest shows how things are going.
import { db } from './db.ts';
import { CLAUDE_MONTHLY_CAP_GBP, GBP_PER_USD, OUTREACH_DAILY_CAP } from './config.ts';
import { usage } from './leads.ts';
import { followUpsDue, sentToday } from './outreach.ts';

const n = (sql: string, ...args: (string | number)[]) => (db.prepare(sql).get(...args) as { n: number }).n;
const MONTH = `datetime('now', 'start of month')`;

// Claude spend this month, split by area: lead jobs are Sales, everything else is Marketing.
// With no area, the whole month, rounded once so it matches the top bar.
function spend(sales?: boolean) {
  const usd = n(`SELECT COALESCE(SUM(cost_usd), 0) AS n FROM claude_usage WHERE created_at >= ${MONTH} AND (? IS NULL OR (job LIKE 'lead:%') = ?)`, ...Array(2).fill(sales === undefined ? null : +sales));
  return +(usd * GBP_PER_USD).toFixed(2);
}

// One count per day or week, oldest first, with empty days filled in.
function series(table: string, column: string, where: string, days: number, step: 'day' | 'week') {
  const rows = db.prepare(`SELECT date(${column}${step === 'week' ? `, 'weekday 1', '-7 days'` : ''}) AS d, COUNT(*) AS n FROM ${table}
    WHERE ${where} AND ${column} >= date('now', '-${days} days') GROUP BY d`).all() as { d: string; n: number }[];
  const by = new Map(rows.map(r => [r.d, r.n]));
  const out: { date: string; count: number }[] = [];
  const start = new Date(), stepDays = step === 'week' ? 7 : 1;
  if (step === 'week') start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7)); // this week's Monday
  for (let i = Math.floor(days / stepDays) - 1; i >= 0; i--) {
    const d = new Date(start.getTime() - i * stepDays * 86_400_000).toISOString().slice(0, 10);
    out.push({ date: d, count: by.get(d) ?? 0 });
  }
  return out;
}

export function marketing() {
  return {
    needs: {
      posts_to_approve: n(`SELECT COUNT(*) AS n FROM posts WHERE status = 'pending_approval'`),
      posts_to_check: n(`SELECT COUNT(*) AS n FROM posts WHERE status IN ('failed', 'check_buffer')`),
    },
    // Named one by one, since the Articles page lists them under their category. A draft with a publish date is a
    // published article reopened with Edit again: the site still has the old version until it is published again.
    articles: db.prepare(`SELECT id, title, category, status, published_at FROM articles WHERE status IN ('draft', 'approved') ORDER BY updated_at DESC LIMIT 10`).all(),
    posts_this_month: n(`SELECT COUNT(*) AS n FROM posts WHERE status = 'sent' AND sent_at >= ${MONTH}`),
    posts_scheduled: n(`SELECT COUNT(*) AS n FROM posts WHERE status = 'sent' AND due_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`),
    articles_this_month: n(`SELECT COUNT(*) AS n FROM articles WHERE status = 'published' AND published_at >= ${MONTH}`),
    articles_published: n(`SELECT COUNT(*) AS n FROM articles WHERE status = 'published'`),
    images_this_month: n(`SELECT COUNT(*) AS n FROM renders WHERE created_at >= ${MONTH}`),
    spend_gbp: spend(false), cap_gbp: CLAUDE_MONTHLY_CAP_GBP, all_spend_gbp: spend(),
    posts_by_week: series('posts', 'sent_at', `status = 'sent'`, 56, 'week'),
    upcoming: db.prepare(`SELECT channel_name, text, due_at FROM posts WHERE status = 'sent' AND due_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ORDER BY due_at LIMIT 5`).all(),
    recent_articles: db.prepare(`SELECT title, category, slug, published_at FROM articles WHERE status = 'published' ORDER BY published_at DESC LIMIT 5`).all(),
  };
}

export function sales() {
  const status = Object.fromEntries((db.prepare(`SELECT status, COUNT(*) AS n FROM leads GROUP BY status`).all() as { status: string; n: number }[]).map(r => [r.status, r.n]));
  const sent = n(`SELECT COUNT(DISTINCT to_email) AS n FROM emails WHERE follow_up_of IS NULL AND status IN ('sent', 'bounced')`);
  const replied = n(`SELECT COUNT(DISTINCT e.to_email) AS n FROM emails e JOIN leads l ON l.id = e.lead_id WHERE e.follow_up_of IS NULL AND e.status = 'sent' AND l.status IN ('replied', 'converted')`);
  const bounced = n(`SELECT COUNT(*) AS n FROM emails WHERE status = 'bounced'`);
  return {
    needs: {
      emails_to_approve: n(`SELECT COUNT(*) AS n FROM emails WHERE status = 'pending_approval'`),
      emails_to_check: n(`SELECT COUNT(*) AS n FROM emails WHERE status IN ('failed', 'check_sent')`),
      follow_ups_due: followUpsDue(),
      replies_to_answer: status.replied ?? 0,
      call_backs_due: n(`SELECT COUNT(*) AS n FROM leads WHERE follow_up_date <= date('now') AND status NOT IN ('converted', 'not_interested', 'not_a_fit', 'archived')`),
    },
    leads: n(`SELECT COUNT(*) AS n FROM leads WHERE status != 'archived'`),
    leads_this_month: n(`SELECT COUNT(*) AS n FROM leads WHERE created_at >= ${MONTH}`),
    status,
    priority: Object.fromEntries((db.prepare(`SELECT COALESCE(priority, 'none') AS p, COUNT(*) AS n FROM leads WHERE status NOT IN ('not_interested', 'not_a_fit', 'archived') GROUP BY p`).all() as { p: string; n: number }[]).map(r => [r.p, r.n])),
    sent_today: sentToday(), daily_cap: OUTREACH_DAILY_CAP,
    sent_this_month: n(`SELECT COUNT(*) AS n FROM emails WHERE status IN ('sent', 'bounced') AND sent_at >= ${MONTH}`),
    emailed: sent, replied, reply_rate: sent ? Math.round(replied / sent * 100) : null, bounce_rate: sent ? Math.round(bounced / sent * 100) : null,
    sent_by_day: series('emails', 'sent_at', `status IN ('sent', 'bounced', 'check_sent')`, 14, 'day'),
    call_backs: db.prepare(`SELECT id, company_name, follow_up_date FROM leads WHERE follow_up_date IS NOT NULL AND follow_up_date <= date('now', '+7 days')
      AND status NOT IN ('converted', 'not_interested', 'not_a_fit', 'archived') ORDER BY follow_up_date LIMIT 8`).all(),
    recent_replies: db.prepare(`SELECT a.lead_id AS id, l.company_name, a.created_at FROM lead_activity a JOIN leads l ON l.id = a.lead_id
      WHERE a.text LIKE 'Replied from %' ORDER BY a.id DESC LIMIT 5`).all(),
    spend_gbp: spend(true), cap_gbp: CLAUDE_MONTHLY_CAP_GBP, all_spend_gbp: spend(),
    usage: usage(),
  };
}
