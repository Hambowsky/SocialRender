// Customers: the businesses Red Cherry IT works for. Their details, notes, emails from David's own mailbox,
// invoices as PDFs, their website's numbers from Google, and a monthly report. Plain code, no Claude.
import { db } from './db.ts';
import { fail, GA4_API_URL, GSC_CREDENTIALS, SMTP_FROM, SMTP_HOST } from './config.ts';
import { lead, updateLead, addNote } from './leads.ts';
import { transport } from './outreach.ts';
import { pdf } from './render.ts';
import { accessToken, query as gscQuery, serviceEmail } from './gsc.ts';
import { pageSpeed } from './analyse.ts';

export const SERVICES = ['Web design', 'Custom web development', 'Website care plan', 'Hosting', 'SEO', 'Conversion rate optimisation', 'AI services', 'Google Ads', 'Social media', 'Email marketing'];
const FIELDS = ['business_name', 'first_name', 'last_name', 'email', 'phone', 'address', 'website_url', 'ga4_property', 'gsc_site'] as const;
export type CustomerInput = Partial<Record<typeof FIELDS[number], string>> & { services?: string[] };
type Row = Record<typeof FIELDS[number], string> & { id: number; services: string; lead_id: number | null; created_at: string; updated_at: string };
type Item = { description: string; qty: number; price: number };
type Invoice = { id: number; customer_id: number; number: number | null; items: string; note: string; vat_rate: number; total: number; due_days: number;
  status: string; error: string | null; issued_on: string | null; due_on: string | null; sent_at: string | null; paid_at: string | null; created_at: string };

const row = (id: number) => (db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as Row | undefined) ?? fail(404, `There is no customer ${id}`);
const log = (id: number, kind: string, text: string) => db.prepare('INSERT INTO customer_activity (customer_id, kind, text) VALUES (?, ?, ?)').run(id, kind, text);
const name = (c: Row) => [c.first_name, c.last_name].filter(Boolean).join(' ');
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const money = (n: number) => `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ukDate = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

const invoiceView = (i: Invoice) => ({ ...i, items: JSON.parse(i.items) as Item[], label: i.number ? `${settings().prefix}${String(i.number).padStart(4, '0')}` : 'Draft',
  overdue: i.status === 'sent' && !!i.due_on && i.due_on < today() });
const view = (c: Row) => ({ ...c, services: JSON.parse(c.services) as string[], contact_name: name(c) });

export function list() {
  return (db.prepare(`SELECT c.*, COALESCE((SELECT SUM(total) FROM invoices i WHERE i.customer_id = c.id AND i.status = 'sent'), 0) AS unpaid,
    EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id = c.id AND i.status = 'sent' AND i.due_on < date('now')) AS overdue
    FROM customers c ORDER BY c.business_name COLLATE NOCASE`).all() as (Row & { unpaid: number; overdue: number })[]).map(c => ({ ...view(c), unpaid: c.unpaid, overdue: !!c.overdue }));
}

export function get(id: number) {
  const c = view(row(id));
  return { ...c,
    activity: db.prepare('SELECT * FROM customer_activity WHERE customer_id = ? ORDER BY id DESC').all(id),
    invoices: (db.prepare('SELECT * FROM invoices WHERE customer_id = ? ORDER BY id DESC').all(id) as Invoice[]).map(invoiceView),
    service_email: GSC_CREDENTIALS ? serviceEmail() : '' };
}

const clean = (c: CustomerInput) => Object.fromEntries(FIELDS.filter(f => c[f] !== undefined).map(f => [f, c[f]!.trim()]));

export function create(c: CustomerInput, leadId: number | null = null) {
  const v = clean(c);
  if (!v.business_name) fail(400, 'Give the business name');
  const cols = [...Object.keys(v), 'services', 'lead_id'];
  const id = Number(db.prepare(`INSERT INTO customers (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...Object.values(v), JSON.stringify(c.services ?? []), leadId).lastInsertRowid);
  return get(id);
}

export function update(id: number, c: CustomerInput) {
  row(id);
  const v: Record<string, string> = clean(c);
  if (v.business_name === '') fail(400, 'The business name cannot be blank');
  if (c.services) v.services = JSON.stringify(c.services);
  if (Object.keys(v).length) db.prepare(`UPDATE customers SET ${Object.keys(v).map(k => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(v), id);
  return get(id);
}

export function remove(id: number) {
  row(id);
  if (db.prepare(`SELECT 1 FROM invoices WHERE customer_id = ? AND number IS NOT NULL`).get(id)) fail(409, 'This customer has invoices, so they are kept for your records');
  db.exec('BEGIN');
  for (const t of ['invoices', 'customer_activity']) db.prepare(`DELETE FROM ${t} WHERE customer_id = ?`).run(id);
  db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  db.exec('COMMIT');
  return { ok: true };
}

export function addCustomerNote(id: number, text: string) {
  row(id);
  log(id, 'note', text.trim());
  return get(id);
}

// A won lead becomes a customer with what we already know, and the lead is marked converted.
export function fromLead(leadId: number) {
  const l = lead(leadId) as any;
  const made = db.prepare('SELECT id FROM customers WHERE lead_id = ?').get(leadId) as { id: number } | undefined;
  if (made) return get(made.id);
  const [first = '', ...rest] = String(l.contact_name ?? '').trim().split(/\s+/);
  const c = create({ business_name: l.company_name, first_name: first, last_name: rest.join(' '), email: l.email, phone: l.phone,
    address: [l.address, l.postcode].filter(Boolean).join(', '), website_url: l.website_url }, leadId);
  updateLead(leadId, { status: 'converted' });
  addNote(leadId, 'Made a customer');
  return c;
}

// Mail from David's own mailbox (the outreach SMTP settings). A client email has no unsubscribe line: it is
// one to one business with someone he works for, not marketing.
function mailReady(c: Row) {
  if (!SMTP_HOST || !SMTP_FROM) fail(503, 'Set SMTP_HOST, SMTP_FROM and the mailbox login before sending');
  if (!c.email) fail(400, 'This customer has no email address');
}
const send = (to: string, subject: string, text: string, attachments: { filename: string; content: Buffer }[] = []) =>
  transport().sendMail({ from: SMTP_FROM, to, subject, text, attachments }).catch((err: Error) => fail(502, `The mail server said: ${err.message}`));

export async function email(id: number, subject: string, body: string) {
  const c = row(id);
  mailReady(c);
  await send(c.email, subject, body);
  log(id, 'email', `Emailed "${subject}"`);
  return get(id);
}

// Invoices. David's own details live in settings, so he can change them in the studio without a redeploy.
export type InvoiceSettings = { from: string; payment: string; prefix: string; start: number; due_days: number; vat_rate: number; vat_number: string };
const DEFAULTS: InvoiceSettings = { from: 'Red Cherry IT', payment: '', prefix: 'RC-', start: 1, due_days: 14, vat_rate: 0, vat_number: '' };
export const settings = (): InvoiceSettings => ({ ...DEFAULTS, ...JSON.parse((db.prepare(`SELECT value FROM settings WHERE key = 'invoice'`).get() as { value: string } | undefined)?.value ?? '{}') });
export function saveSettings(s: Partial<InvoiceSettings>) {
  const v = { ...settings(), ...s };
  db.prepare(`INSERT INTO settings (key, value) VALUES ('invoice', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(v));
  return v;
}

export type InvoiceInput = { items: Item[]; note?: string; due_days?: number };
const totals = (items: Item[], vat: number) => {
  const net = Math.round(items.reduce((s, i) => s + i.qty * i.price, 0) * 100) / 100;
  const tax = Math.round(net * vat) / 100;
  return { net, tax, total: Math.round((net + tax) * 100) / 100 };
};

export function createInvoice(id: number, inv: InvoiceInput) {
  row(id);
  const s = settings(), items = inv.items.filter(i => i.description.trim());
  if (!items.length) fail(400, 'Add at least one line to the invoice');
  const r = db.prepare('INSERT INTO invoices (customer_id, items, note, vat_rate, total, due_days) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, JSON.stringify(items), inv.note ?? '', s.vat_rate, totals(items, s.vat_rate).total, inv.due_days ?? s.due_days);
  return invoiceView(getInvoice(Number(r.lastInsertRowid)));
}
const getInvoice = (id: number) => (db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as Invoice | undefined) ?? fail(404, `There is no invoice ${id}`);

export function deleteInvoice(id: number) {
  const i = getInvoice(id);
  if (i.number) fail(409, 'A sent invoice is kept for your records. Mark it paid, or send a credit note.');
  db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
  return { ok: true };
}

export function markPaid(id: number, paid: boolean) {
  const i = getInvoice(id);
  if (!['sent', 'paid'].includes(i.status)) fail(409, 'Only a sent invoice can be marked paid');
  db.prepare(`UPDATE invoices SET status = ?, paid_at = ? WHERE id = ?`).run(paid ? 'paid' : 'sent', paid ? new Date().toISOString() : null, id);
  const v = invoiceView(getInvoice(id));
  log(i.customer_id, 'invoice', `Invoice ${v.label} marked ${paid ? 'paid' : 'unpaid'}`);
  return v;
}

export const invoicePdf = (id: number) => { const i = invoiceView(getInvoice(id)); return pdf(invoiceHtml(row(i.customer_id), i)); };
export const previewInvoice = (id: number, inv: InvoiceInput) => {
  const s = settings(), items = inv.items.filter(i => i.description.trim());
  return pdf(invoiceHtml(row(id), { label: 'Draft', items, note: inv.note ?? '', vat_rate: s.vat_rate, issued_on: null, due_days: inv.due_days ?? s.due_days, due_on: null }));
};

// Sent once: the row is numbered and claimed as "sending" before the mail goes. A mail server error puts it
// back to draft with its number, so sending again reuses the number. A crash mid send leaves "sending" for David to check.
export async function sendInvoice(id: number, message: string) {
  const i = getInvoice(id), c = row(i.customer_id);
  if (i.status !== 'draft') fail(409, i.status === 'sending' ? 'This invoice may already have gone. Check your sent mail, then mark it paid or sent.' : 'This invoice has already been sent');
  mailReady(c);
  const s = settings(), on = today();
  db.exec('BEGIN');
  db.prepare(`UPDATE invoices SET status = 'sending', error = NULL, issued_on = COALESCE(issued_on, ?), due_on = COALESCE(due_on, ?),
    number = COALESCE(number, (SELECT MAX(COALESCE((SELECT MAX(number) FROM invoices), 0), ?) + 1)) WHERE id = ?`).run(on, addDays(on, i.due_days), s.start - 1, id);
  db.exec('COMMIT');
  const v = invoiceView(getInvoice(id));
  try {
    const file = await pdf(invoiceHtml(c, v));
    await send(c.email, `Invoice ${v.label} from Red Cherry IT`, message, [{ filename: `invoice-${v.label}.pdf`, content: file }]);
  } catch (err) {
    db.prepare(`UPDATE invoices SET status = 'draft', error = ? WHERE id = ?`).run((err as Error).message, id);
    throw err;
  }
  db.prepare(`UPDATE invoices SET status = 'sent', sent_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
  log(c.id, 'invoice', `Sent invoice ${v.label} for ${money(v.total)}, due ${ukDate(v.due_on!)}`);
  return invoiceView(getInvoice(id));
}

const PAGE_CSS = `
  @font-face { font-family: "Archivo"; font-weight: 400; src: url(/fonts/archivo-latin-400-normal.woff2) format("woff2"); }
  @font-face { font-family: "Archivo"; font-weight: 500; src: url(/fonts/archivo-latin-500-normal.woff2) format("woff2"); }
  @font-face { font-family: "Archivo"; font-weight: 900; src: url(/fonts/archivo-latin-900-normal.woff2) format("woff2"); }
  @page { size: A4; margin: 16mm 16mm 18mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 400 10.5pt/1.45 Archivo, sans-serif; color: #444; }
  h1, h2, b, th { color: #1a1a1a; }
  h1 { font-weight: 900; font-size: 26pt; line-height: 1.1; margin: 6mm 0 1mm; }
  h1 em { font-style: normal; color: #b5333f; }
  h2 { font-weight: 900; font-size: 14pt; margin: 8mm 0 3mm; break-after: avoid; }
  .top { display: flex; justify-content: space-between; align-items: center; }
  .top img { height: 11mm; }
  .tag { font: 500 8pt Archivo; letter-spacing: .12em; text-transform: uppercase; color: #a89c9c; }
  .bar { width: 18mm; height: 1.4mm; background: #b5333f; margin-top: 6mm; }
  .muted { color: #a89c9c; }
  .pre { white-space: pre-line; }
  table { width: 100%; border-collapse: collapse; margin-top: 4mm; }
  th, td { text-align: left; padding: 2.4mm 0; border-bottom: 1px solid #eee; vertical-align: top; }
  th { font-weight: 500; font-size: 9pt; }
  .num { text-align: right; white-space: nowrap; padding-left: 4mm; }
  .end { margin-top: 8mm; padding: 5mm 6mm; background: #f6f3f3; border-left: 1.4mm solid #b5333f; break-inside: avoid; }
  footer { margin-top: 8mm; padding-top: 3mm; border-top: 1px solid #1a1a1a; display: flex; justify-content: space-between; font-size: 9pt; }
  footer span:last-child { color: #b5333f; font-weight: 500; }`;
const page = (tag: string, body: string) => `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><style>${PAGE_CSS}</style></head><body>
  <div class="top"><img src="/assets/logo.png" alt="Red Cherry IT"><span class="tag">${esc(tag)}</span></div><div class="bar"></div>${body}
  <footer><span><b>Red Cherry IT</b>, web design and digital marketing</span><span>redcherryit.com</span></footer></body></html>`;

type InvoiceShape = { label: string; items: Item[]; note: string; vat_rate: number; issued_on: string | null; due_days: number; due_on: string | null };
function invoiceHtml(c: Row, i: InvoiceShape) {
  const s = settings(), t = totals(i.items, i.vat_rate), issued = i.issued_on ?? today(), due = i.due_on ?? addDays(issued, i.due_days);
  return page(`Invoice ${i.label}`, `
  <div style="display:flex;justify-content:space-between;gap:10mm;margin-top:6mm">
    <div><h1>Invoice</h1><p class="muted" style="margin:0">${esc(i.label)}</p></div>
    <div style="text-align:right" class="pre">${esc(s.from)}${s.vat_number ? `\nVAT number ${esc(s.vat_number)}` : ''}</div>
  </div>
  <div style="display:flex;justify-content:space-between;gap:10mm;margin-top:8mm">
    <div class="pre"><b>Bill to</b>\n${esc(c.business_name)}${name(c) ? `\n${esc(name(c))}` : ''}${c.address ? `\n${esc(c.address)}` : ''}</div>
    <div style="text-align:right"><b>Date</b> ${esc(ukDate(issued))}<br><b>Due</b> ${esc(ukDate(due))}</div>
  </div>
  <table><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th></tr></thead><tbody>
    ${i.items.map(x => `<tr><td>${esc(x.description)}</td><td class="num">${esc(x.qty)}</td><td class="num">${money(x.price)}</td><td class="num">${money(x.qty * x.price)}</td></tr>`).join('')}
  </tbody></table>
  <table style="width:45%;margin-left:auto">
    ${i.vat_rate ? `<tr><td>Subtotal</td><td class="num">${money(t.net)}</td></tr><tr><td>VAT at ${esc(i.vat_rate)}%</td><td class="num">${money(t.tax)}</td></tr>` : ''}
    <tr><td><b>Total due</b></td><td class="num"><b>${money(t.total)}</b></td></tr>
  </table>
  ${i.note ? `<p class="pre">${esc(i.note)}</p>` : ''}
  ${s.payment ? `<div class="end pre"><b>How to pay</b>\n${esc(s.payment)}\nPlease use ${esc(i.label === 'Draft' ? 'the invoice number' : i.label)} as the reference.</div>` : ''}`);
}

// Their website's numbers: Google Analytics visitors and Google search, the last 28 days against the 28 before,
// plus Google's speed scores. Each part is optional, so a site with only Search Console still gets that.
// Kept for the day, as the numbers only move daily.
type Ga = { users: number; sessions: number; views: number };
async function ga4(property: string, from: string, to: string, dimension?: string) {
  const res = await fetch(`${GA4_API_URL}/properties/${encodeURIComponent(property)}:runReport`, {
    method: 'POST', signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ dateRanges: [{ startDate: from, endDate: to }], metrics: [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'screenPageViews' }],
      ...(dimension ? { dimensions: [{ name: dimension }], orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 6 } : {}) }),
  });
  const body = await res.json().catch(() => ({})) as { rows?: { dimensionValues?: { value: string }[]; metricValues: { value: string }[] }[]; error?: { message?: string } };
  if (res.status === 403) fail(502, `Google Analytics refused: add ${serviceEmail()} as a Viewer on property ${property}`);
  if (!res.ok) fail(502, `Google Analytics: ${body.error?.message ?? res.status}`);
  return (body.rows ?? []).map(r => ({ name: r.dimensionValues?.[0]?.value ?? '', users: +r.metricValues[0].value, sessions: +r.metricValues[1].value, views: +r.metricValues[2].value }));
}
const zero: Ga = { users: 0, sessions: 0, views: 0 };

export const gscSite = (c: Row) => c.gsc_site || (c.website_url ? `sc-domain:${new URL(/^https?:/.test(c.website_url) ? c.website_url : `https://${c.website_url}`).hostname.replace(/^www\./, '')}` : '');

export async function analytics(id: number, now = new Date()) {
  const c = row(id), key = `cust-analytics:${id}:${now.toISOString().slice(0, 10)}`;
  const saved = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (saved) return JSON.parse(saved.value);
  const day = (back: number) => new Date(now.getTime() - back * 86_400_000).toISOString().slice(0, 10);
  // Search figures settle after about three days, so both windows end three days ago and line up.
  const to = day(3), from = day(30), prevTo = day(31), prevFrom = day(58);
  const out: any = { from, to, errors: {} };
  const tryPart = async (part: string, work: () => Promise<unknown>) => { try { out[part] = await work(); } catch (err) { out.errors[part] = (err as Error).message; } };
  const google = GSC_CREDENTIALS ? '' : 'GSC_CREDENTIALS is not set, so Google numbers are off';
  await Promise.all([
    c.ga4_property ? tryPart('visitors', async () => {
      if (google) fail(503, google);
      const [cur, before, channels, pages] = await Promise.all([ga4(c.ga4_property, from, to), ga4(c.ga4_property, prevFrom, prevTo),
        ga4(c.ga4_property, from, to, 'sessionDefaultChannelGroup'), ga4(c.ga4_property, from, to, 'pagePath')]);
      const strip = ({ name, ...r }: Ga & { name: string }) => r;
      return { ...strip(cur[0] ? cur[0] : { ...zero, name: '' }), before: strip(before[0] ? before[0] : { ...zero, name: '' }),
        channels: channels.map(r => ({ name: r.name, sessions: r.sessions })), pages: pages.map(r => ({ path: r.name, views: r.views })) };
    }) : (out.errors.visitors = 'Add their Google Analytics property id to see visitors'),
    gscSite(c) ? tryPart('search', async () => {
      if (google) fail(503, google);
      const site = gscSite(c);
      const [total, before, queries] = await Promise.all([gscQuery(from, to, [], site), gscQuery(prevFrom, prevTo, [], site), gscQuery(from, to, ['query'], site)]);
      const sum = (r?: { clicks: number; impressions: number; position: number }) => ({ clicks: r?.clicks ?? 0, impressions: r?.impressions ?? 0, position: +(r?.position ?? 0).toFixed(1) });
      return { site, ...sum(total[0]), before: sum(before[0]),
        queries: queries.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions).slice(0, 8).map(r => ({ query: r.keys[0], clicks: r.clicks, impressions: r.impressions, position: +r.position.toFixed(1) })) };
    }) : (out.errors.search = 'Add their website to see Google search'),
    c.website_url ? tryPart('speed', () => pageSpeed(/^https?:/.test(c.website_url) ? c.website_url : `https://${c.website_url}`)) : undefined,
  ]);
  out.checked_at = new Date().toISOString();
  if (out.visitors || out.search) db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(key, JSON.stringify(out));
  db.prepare(`DELETE FROM settings WHERE key LIKE 'cust-analytics:%' AND substr(key, -10) < ?`).run(day(7));
  return out;
}

// The monthly client report: their numbers, and what David did for them in his own words.
const change = (now: number, was: number) => !was ? '' : ` <span class="muted">(${now >= was ? 'up' : 'down'} ${Math.abs(Math.round((now - was) / was * 100))}% on the 28 days before)</span>`;
export function reportHtml(id: number, a: any, work: string) {
  const c = row(id), v = a.visitors, s = a.search, sp = a.speed;
  const stat = (label: string, n: number, was?: number) => `<tr><td>${esc(label)}</td><td class="num"><b>${n.toLocaleString('en-GB')}</b>${was === undefined ? '' : change(n, was)}</td></tr>`;
  return page(`Monthly report · ${ukDate(today())}`, `
  <h1>How <em>${esc(c.business_name)}</em> did online</h1>
  <p class="muted" style="margin:0">${esc(c.website_url)} · ${esc(ukDate(a.from))} to ${esc(ukDate(a.to))}</p>
  ${work.trim() ? `<h2>What we did for you</h2><p class="pre">${esc(work.trim())}</p>` : ''}
  ${v ? `<h2>Visitors</h2><table>${stat('People who visited', v.users, v.before.users)}${stat('Visits', v.sessions, v.before.sessions)}${stat('Pages viewed', v.views, v.before.views)}</table>
    ${v.channels.length ? `<h2>Where visitors came from</h2><table>${v.channels.map((r: any) => stat(r.name, r.sessions)).join('')}</table>` : ''}
    ${v.pages.length ? `<h2>Most viewed pages</h2><table>${v.pages.map((r: any) => stat(r.path, r.views)).join('')}</table>` : ''}` : ''}
  ${s ? `<h2>Google search</h2><table>${stat('Clicks from Google', s.clicks, s.before.clicks)}${stat('Times you showed in Google', s.impressions, s.before.impressions)}
    <tr><td>Average position</td><td class="num"><b>${esc(s.position)}</b></td></tr></table>
    ${s.queries.length ? `<h2>Searches that found you</h2><table><thead><tr><th>Search</th><th class="num">Clicks</th><th class="num">Position</th></tr></thead>
      ${s.queries.map((q: any) => `<tr><td>${esc(q.query)}</td><td class="num">${q.clicks}</td><td class="num">${q.position}</td></tr>`).join('')}</table>` : ''}` : ''}
  ${sp?.scores ? `<h2>Google's website scores</h2><table>${[['performance', 'Speed on phones'], ['seo', 'Search engine basics'], ['accessibility', 'Accessibility'], ['best-practices', 'Best practices']]
    .filter(([k]) => k in sp.scores).map(([k, l]) => stat(`${l} (out of 100)`, sp.scores[k])).join('')}</table>` : ''}
  <div class="end"><b>Any questions?</b><br>Just reply to the email this came with, or call us.</div>`);
}

export async function reportPdf(id: number, work: string) { return pdf(reportHtml(id, await analytics(id), work)); }

export async function sendReport(id: number, work: string, subject: string, message: string) {
  const c = row(id);
  mailReady(c);
  const file = await reportPdf(id, work);
  await send(c.email, subject, message, [{ filename: `report-${today().slice(0, 7)}.pdf`, content: file }]);
  log(id, 'report', `Sent the monthly report "${subject}"`);
  return get(id);
}

// Lines for the report's "What we did" box: this month's notes, oldest first.
export function recentNotes(id: number) {
  row(id);
  return (db.prepare(`SELECT text FROM customer_activity WHERE customer_id = ? AND kind = 'note' AND created_at >= datetime('now', '-31 days') ORDER BY id`).all(id) as { text: string }[]).map(n => n.text);
}
