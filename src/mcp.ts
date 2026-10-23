// An MCP endpoint so Hermes (or any MCP client) can use the studio. Each tool is one of the normal HTTP routes,
// called from inside the app, so the same checks, caps and approval queues apply. Nothing here approves, publishes
// or sends: posts and emails still wait for David on their pages.
// ponytail: plain JSON responses, no SSE stream or sessions; add them if a client ever needs server pushes.
import type { FastifyInstance } from 'fastify';
import { PUBLIC_URL } from './config.ts';

type Args = Record<string, any>;
type Tool = { name: string; description: string; read?: boolean; props?: Record<string, unknown>; required?: string[];
  call: (a: Args) => { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string; body?: unknown } };

const str = (description: string) => ({ type: 'string', description });
const int = (description: string) => ({ type: 'integer', description });
const channels = { type: 'array', description: 'Buffer channels, from list_buffer_channels', items: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, name: { type: 'string' } } } };
const qs = (a: Args) => { const q = new URLSearchParams(Object.entries(a).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)])).toString(); return q ? `?${q}` : ''; };
const id = int('Id');
const pick = (a: Args, keys: string[]) => Object.fromEntries(keys.filter(k => a[k] !== undefined).map(k => [k, a[k]]));

export const TOOLS: Tool[] = [
  { name: 'marketing_dashboard', read: true, description: 'Marketing: what is waiting on David (posts to approve, articles to review), posts and articles this month, upcoming posts, Claude spend.',
    call: () => ({ method: 'GET', url: '/dashboard/marketing' }) },
  { name: 'sales_dashboard', read: true, description: 'Sales: what is waiting on David (emails to approve, replies, follow ups due), lead counts, reply rate, Claude spend.',
    call: () => ({ method: 'GET', url: '/dashboard/sales' }) },
  { name: 'list_templates', read: true, description: 'Image and motion templates with their text fields and sizes.',
    call: () => ({ method: 'GET', url: '/templates' }) },
  { name: 'write_social_copy', description: 'Claude writes headline, highlight word, subtitle and caption for a template, from a topic or a page URL. Queues nothing.',
    props: { template: str('Template name'), topic: str('What the post is about'), url: str('A page to write about instead of a topic'), keyword: str('Optional keyword'), audience: str('Optional audience') },
    required: ['template'], call: a => ({ method: 'POST', url: '/copy', body: pick(a, ['template', 'topic', 'url', 'keyword', 'audience']) }) },
  { name: 'render_image', description: 'Renders a template to PNG. Returns render_id (for queue_social_post) and a public image URL. Fails with the fields to shorten if text does not fit.',
    props: { template: str('Template name'), fields: { type: 'object', description: 'Text fields, such as headline, highlight_word, subtitle, tag', additionalProperties: { type: 'string' } }, size: str('Optional, such as 1080x1350') },
    required: ['template', 'fields'], call: a => ({ method: 'POST', url: '/render?format=json', body: pick(a, ['template', 'fields', 'size']) }) },
  { name: 'list_buffer_channels', read: true, description: 'Buffer channels posts can go to.',
    call: () => ({ method: 'GET', url: '/buffer/channels' }) },
  { name: 'queue_social_post', description: 'Adds a rendered image and caption to the approval list. Nothing goes to Buffer until David approves it. Pass the same idempotency_key on a retry so it is never added twice.',
    props: { render_id: str('From render_image'), channels, text: str('The caption'), mode: { enum: ['queue', 'scheduled', 'draft'], description: 'Buffer queue, a set time, or a Buffer draft' },
      due_at: str('ISO date and time, for scheduled'), idempotency_key: str('Any unique string for this post') },
    required: ['render_id', 'channels', 'text', 'mode'], call: a => ({ method: 'POST', url: '/posts', body: pick(a, ['render_id', 'channels', 'text', 'mode', 'due_at', 'idempotency_key']) }) },
  { name: 'list_posts', read: true, description: 'Social posts, optionally by status (pending_approval, sent, failed, check_buffer, rejected).',
    props: { status: str('Optional status') }, call: a => ({ method: 'GET', url: `/posts${qs(pick(a, ['status']))}` }) },
  { name: 'list_article_categories', read: true, description: 'Website guide categories articles can be written for.',
    call: () => ({ method: 'GET', url: '/articles/categories' }) },
  { name: 'research_article_ideas', description: 'Claude suggests article ideas for a category, with sources.',
    props: { category: str('From list_article_categories'), focus: str('Optional focus'), audience: str('Optional audience') },
    required: ['category'], call: a => ({ method: 'POST', url: '/articles/research', body: pick(a, ['category', 'focus', 'audience']) }) },
  { name: 'draft_article', description: 'Claude drafts an article into the review list. It is not published until David approves and publishes it.',
    props: { topic: str('The article topic'), category: str('From list_article_categories'), keyword: str('Optional keyword'), audience: str('Optional audience'), sources: str('Optional sources, one per line') },
    required: ['topic'], call: a => ({ method: 'POST', url: '/articles', body: pick(a, ['topic', 'category', 'keyword', 'audience', 'sources']) }) },
  { name: 'list_articles', read: true, description: 'Articles with their status (draft, approved, published).',
    call: () => ({ method: 'GET', url: '/articles' }) },
  { name: 'list_campaigns', read: true, description: 'Lead finding campaigns with their lead counts.',
    call: () => ({ method: 'GET', url: '/campaigns' }) },
  { name: 'run_campaign', description: 'Starts a campaign looking for new leads, within its monthly caps. Runs in the background.',
    props: { id: int('Campaign id') }, required: ['id'], call: a => ({ method: 'POST', url: `/campaigns/${Number(a.id)}/run` }) },
  { name: 'list_leads', read: true, description: 'Leads, filtered.',
    props: { campaign: int('Campaign id'), status: str('new, contacted, replied, bounced, converted, not_interested, not_a_fit, archived'), priority: { enum: ['hot', 'warm', 'cold'] }, q: str('Search text'),
      has_email: { enum: ['yes', 'no'] }, has_website: { enum: ['yes', 'no'] } },
    call: a => ({ method: 'GET', url: `/leads${qs(pick(a, ['campaign', 'status', 'priority', 'q', 'has_email', 'has_website']))}` }) },
  { name: 'draft_campaign_emails', description: 'Claude drafts a first email for every new lead with an email address in a campaign. They wait for David to approve. Returns a job id for check_job.',
    props: { id: int('Campaign id') }, required: ['id'], call: a => ({ method: 'POST', url: `/campaigns/${Number(a.id)}/email` }) },
  { name: 'draft_follow_ups', description: 'Claude drafts follow up emails for leads that are due one. They wait for David to approve. Returns a job id for check_job.',
    call: () => ({ method: 'POST', url: '/emails/follow-ups' }) },
  { name: 'check_job', read: true, description: 'Result of a background job, such as draft_campaign_emails.',
    props: { job: str('Job id') }, required: ['job'], call: a => ({ method: 'GET', url: `/jobs/${encodeURIComponent(String(a.job))}` }) },
  // Sales: campaigns
  { name: 'create_campaign', description: 'Creates a lead finding campaign, for example plumbers in Newcastle and Durham. Then call run_campaign with its id to find the leads.',
    props: { name: str('A short name, such as "Plumbers, Newcastle and Durham"'), industries: str('Comma separated trades, such as "plumbers, heating engineers"'), towns: str('Comma separated towns, such as "Newcastle upon Tyne, Durham"'),
      lead_type: { enum: ['no_website', 'outdated_website', 'both'], description: 'Businesses with no website, an outdated one, or either. Use both unless David says otherwise.' },
      max_leads: { type: 'integer', minimum: 1, maximum: 100, description: 'Most leads to find in one run. Use 50 unless David says otherwise.' },
      sources: { type: 'array', items: { enum: ['places', 'directories'] }, description: 'Google Places and/or web directories. Use both unless David says otherwise.' } },
    required: ['name', 'industries', 'towns', 'lead_type', 'max_leads', 'sources'], call: a => ({ method: 'POST', url: '/campaigns', body: pick(a, ['name', 'industries', 'towns', 'lead_type', 'max_leads', 'sources']) }) },
  { name: 'get_campaign', read: true, description: 'One campaign with its settings, run progress and lead counts.', props: { id }, required: ['id'], call: a => ({ method: 'GET', url: `/campaigns/${Number(a.id)}` }) },
  { name: 'update_campaign', description: 'Changes a campaign. Send every field, as in create_campaign.',
    props: { id, name: str('Name'), industries: str('Comma separated trades'), towns: str('Comma separated towns'), lead_type: { enum: ['no_website', 'outdated_website', 'both'] },
      max_leads: { type: 'integer', minimum: 1, maximum: 100 }, sources: { type: 'array', items: { enum: ['places', 'directories'] } } },
    required: ['id', 'name', 'industries', 'towns', 'lead_type', 'max_leads', 'sources'], call: a => ({ method: 'PUT', url: `/campaigns/${Number(a.id)}`, body: pick(a, ['name', 'industries', 'towns', 'lead_type', 'max_leads', 'sources']) }) },
  { name: 'delete_campaign', description: 'Deletes a campaign. Only when David asks.', props: { id }, required: ['id'], call: a => ({ method: 'DELETE', url: `/campaigns/${Number(a.id)}` }) },
  { name: 'analyse_campaign', description: 'Checks the websites of a campaign\'s leads (speed, mobile, SSL and so on) and rates them hot, warm or cold. Runs in the background.',
    props: { id, all: { type: 'boolean', description: 'true to check every lead again, not just new ones' } }, required: ['id'], call: a => ({ method: 'POST', url: `/campaigns/${Number(a.id)}/analyse${a.all ? '?all=true' : ''}` }) },
  { name: 'usage', read: true, description: 'This month\'s lead search use against the free limits.', call: () => ({ method: 'GET', url: '/campaigns/usage' }) },
  // Sales: leads
  { name: 'get_lead', read: true, description: 'One lead with its website review, notes, activity and emails.', props: { id }, required: ['id'], call: a => ({ method: 'GET', url: `/leads/${Number(a.id)}` }) },
  { name: 'update_lead', description: 'Changes a lead\'s details, status or follow up date (YYYY-MM-DD, or null to clear).',
    props: { id, company_name: str('Name'), contact_name: str('Contact'), phone: str('Phone'), email: str('Email'), website_url: str('Website'),
      status: { enum: ['new', 'contacted', 'replied', 'bounced', 'converted', 'not_interested', 'not_a_fit', 'archived'] }, follow_up_date: { type: ['string', 'null'] } },
    required: ['id'], call: a => ({ method: 'PUT', url: `/leads/${Number(a.id)}`, body: pick(a, ['company_name', 'contact_name', 'phone', 'email', 'website_url', 'status', 'follow_up_date']) }) },
  { name: 'add_lead_note', description: 'Adds a note to a lead.', props: { id, text: str('The note') }, required: ['id', 'text'], call: a => ({ method: 'POST', url: `/leads/${Number(a.id)}/notes`, body: { text: a.text } }) },
  { name: 'analyse_lead', description: 'Checks one lead\'s website and rates it.', props: { id }, required: ['id'], call: a => ({ method: 'POST', url: `/leads/${Number(a.id)}/analyse` }) },
  { name: 'draft_lead_email', description: 'Claude drafts a first email to one lead, into the approval list. Returns a job id for check_job.', props: { id }, required: ['id'], call: a => ({ method: 'POST', url: `/leads/${Number(a.id)}/email` }) },
  // Sales: emails
  { name: 'list_emails', read: true, description: 'Outreach emails with their status, plus sent today against the daily limit and follow ups due.', call: () => ({ method: 'GET', url: '/emails' }) },
  { name: 'edit_email', description: 'Changes the subject or body of an email waiting for approval.', props: { id, subject: str('Subject'), body: str('Body') }, required: ['id'],
    call: a => ({ method: 'PUT', url: `/emails/${Number(a.id)}`, body: pick(a, ['subject', 'body']) }) },
  { name: 'reject_email', description: 'Rejects an email so it is never sent.', props: { id }, required: ['id'], call: a => ({ method: 'POST', url: `/emails/${Number(a.id)}/reject` }) },
  { name: 'list_do_not_email', read: true, description: 'The Do not email list.', call: () => ({ method: 'GET', url: '/suppression' }) },
  { name: 'add_do_not_email', description: 'Adds addresses to the Do not email list.', props: { emails: { type: 'array', items: { type: 'string' } } }, required: ['emails'], call: a => ({ method: 'POST', url: '/suppression', body: { emails: a.emails } }) },
  { name: 'list_case_studies', read: true, description: 'Case studies outreach emails can mention.', call: () => ({ method: 'GET', url: '/case-studies' }) },
  { name: 'save_case_studies', description: 'Adds case studies, or updates them by client name.',
    props: { rows: { type: 'array', items: { type: 'object', required: ['client', 'industry', 'blurb'], properties: { client: { type: 'string' }, industry: { type: 'string' }, blurb: { type: 'string' } } } } },
    required: ['rows'], call: a => ({ method: 'POST', url: '/case-studies', body: { rows: a.rows } }) },
  { name: 'delete_case_study', description: 'Deletes a case study.', props: { id }, required: ['id'], call: a => ({ method: 'DELETE', url: `/case-studies/${Number(a.id)}` }) },
  // Marketing
  { name: 'reject_post', description: 'Rejects a social post so it never goes to Buffer.', props: { id }, required: ['id'], call: a => ({ method: 'POST', url: `/posts/${Number(a.id)}/reject` }) },
  { name: 'render_video', description: 'Renders a motion template to an MP4 clip (slow). Returns its id and URL.',
    props: { template: str('A motion-* template'), fields: { type: 'object', additionalProperties: { type: 'string' } }, size: str('Optional, such as 1080x1920') },
    required: ['template', 'fields'], call: a => ({ method: 'POST', url: '/render/video', body: pick(a, ['template', 'fields', 'size']) }) },
  { name: 'find_article_sources', description: 'Claude finds sources for an article topic.', props: { category: str('Category'), topic: str('Topic'), keyword: str('Optional'), audience: str('Optional') },
    required: ['category', 'topic'], call: a => ({ method: 'POST', url: '/articles/sources', body: pick(a, ['category', 'topic', 'keyword', 'audience']) }) },
  { name: 'get_article', read: true, description: 'One article with its text, checks and status.', props: { id }, required: ['id'], call: a => ({ method: 'GET', url: `/articles/${Number(a.id)}` }) },
  { name: 'update_article', description: 'Changes an article\'s title, summary, slug, category, body (Markdown) or sources.',
    props: { id, title: str('Title'), summary: str('Summary'), slug: str('Slug'), category: str('Category'), body: str('Markdown body'), sources: str('Sources') },
    required: ['id'], call: a => ({ method: 'PUT', url: `/articles/${Number(a.id)}`, body: pick(a, ['title', 'summary', 'slug', 'category', 'body', 'sources']) }) },
  { name: 'reject_article', description: 'Rejects an article draft.', props: { id }, required: ['id'], call: a => ({ method: 'POST', url: `/articles/${Number(a.id)}/reject` }) },
  { name: 'reopen_article', description: 'Reopens an article for editing.', props: { id }, required: ['id'], call: a => ({ method: 'POST', url: `/articles/${Number(a.id)}/reopen` }) },
  { name: 'article_social_posts', description: 'Claude writes and renders social posts for a published article and adds them to the approval list.',
    props: { id, template: str('Template'), channels, mode: { enum: ['queue', 'scheduled', 'draft'] }, due_at: str('ISO date and time, for scheduled') },
    required: ['id', 'template', 'channels', 'mode'], call: a => ({ method: 'POST', url: `/articles/${Number(a.id)}/social`, body: pick(a, ['template', 'channels', 'mode', 'due_at']) }) },
  { name: 'claude_spend', read: true, description: 'Claude spend this month against the cap, and the latest calls.', call: () => ({ method: 'GET', url: '/usage' }) },
];

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const toolList = TOOLS.map(t => ({ name: t.name, description: t.description,
  inputSchema: { type: 'object', properties: t.props ?? {}, ...(t.required ? { required: t.required } : {}) },
  annotations: { readOnlyHint: !!t.read } }));

export function registerMcp(app: FastifyInstance) {
  // No server to client stream or sessions, which the spec allows by answering GET and DELETE with 405.
  app.route({ method: ['GET', 'DELETE'], url: '/mcp', handler: async (_req, reply) => reply.code(405).header('allow', 'POST').send({ error: 'Use POST' }) });
  app.post<{ Body: any }>('/mcp', async (req, reply) => {
    const m = req.body as Args;
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return reply.code(400).send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
    if (m.id === undefined) return reply.code(202).send(); // a notification
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id: m.id, result });
    const err = (code: number, message: string) => ({ jsonrpc: '2.0', id: m.id, error: { code, message } });
    switch (m.method) {
      case 'initialize': {
        const asked = m.params?.protocolVersion;
        return ok({ protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0], capabilities: { tools: {} },
          serverInfo: { name: 'red-cherry-studio', version: '1.0.0' },
          instructions: 'The Red Cherry IT studio. Use it to make social images and copy, draft articles and outreach emails, and see what is waiting on David. Nothing is posted, published or emailed until David approves it in the studio.' });
      }
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: toolList });
      case 'tools/call': {
        const tool = TOOLS.find(t => t.name === m.params?.name);
        if (!tool) return err(-32602, `Unknown tool: ${m.params?.name}`);
        const { method, url, body } = tool.call(m.params?.arguments ?? {});
        const res = await app.inject({ method, url, headers: { 'x-api-key': String(req.headers['x-api-key']) }, ...(body ? { payload: body as object } : {}) });
        let text = res.body;
        if (res.statusCode < 300 && tool.name === 'render_image') {
          const r = res.json();
          text = JSON.stringify({ render_id: r.id, width: r.width, height: r.height, image_url: PUBLIC_URL ? `${PUBLIC_URL}/public/renders/${r.id}.png` : undefined });
        }
        return ok({ content: [{ type: 'text', text }], isError: res.statusCode >= 400 });
      }
      default: return err(-32601, `Method not found: ${m.method}`);
    }
  });
}
