// Apollo.io: a campaign source for businesses, and the person to write to at each lead. Searching people is free;
// a company search page costs 1 credit and revealing a person costs 1 credit when Apollo finds them. Every call is
// cached for the day and the month's credits are capped, so a loop cannot run through the plan.
import { db } from './db.ts';
import { APOLLO_API_KEY, APOLLO_API_URL, APOLLO_MONTHLY_CREDITS, fail } from './config.ts';
import { cached } from './leads.ts';

export type Person = { name: string; first_name: string; title: string; email: string; email_status: string; linkedin_url: string };
export type Company = { employees: number | null; founded_year: number | null; industry: string; description: string; linkedin_url: string };
export type ApolloFind = { person: Person | null; company: Company | null; checked_at: string };

// Credits used this calendar month, as Apollo reported them on each call.
export const creditsUsed = () => (db.prepare(`SELECT COALESCE(SUM(json_extract(body, '$.credits')), 0) AS n FROM api_cache
  WHERE key LIKE 'apollo:%' AND created_at >= datetime('now', 'start of month')`).get() as { n: number }).n;

async function call(path: string, body: object, credits: (json: any) => number) {
  return cached('apollo', { path, body }, async () => {
    if (creditsUsed() >= APOLLO_MONTHLY_CREDITS) fail(429, `This month's ${APOLLO_MONTHLY_CREDITS} Apollo credits are used up`);
    const res = await fetch(`${APOLLO_API_URL}/api/v1/${path}`, { method: 'POST', signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json', 'cache-control': 'no-cache', 'x-api-key': APOLLO_API_KEY }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({})) as any;
    if (!res.ok) fail(502, `Apollo said: ${json.error ?? json.message ?? res.status}${res.status === 403 ? '. The key may need to be a master API key.' : ''}`);
    return { ...json, credits: credits(json) };
  });
}

type Org = { id: string; name?: string; website_url?: string | null; phone?: string | null; primary_phone?: { number?: string } | null };

// Businesses in a town whose Apollo keywords match the industry, as campaign results. 1 credit per page of up to 100.
export async function companies(industry: string, town: string, want: number) {
  const words = [...new Set([industry, industry.replace(/s$/i, '')])];
  const data = await call('mixed_companies/search', { organization_locations: [`${town}, United Kingdom`], q_organization_keyword_tags: words,
    page: 1, per_page: Math.min(100, Math.max(10, want)) }, () => 1);
  return ((data.organizations ?? []) as Org[]).filter(o => o.name).map(o => ({
    company_name: o.name!, phone: o.phone ?? o.primary_phone?.number ?? '', email: '', website_url: o.website_url ?? '', address: '', postcode: '', town, industry,
    source: 'apollo', source_ref: o.id, rating: null, reviews: null,
  }));
}

// Owners first, then senior people. The free search shows who is there; only the chosen person is paid for.
const RANK = ['owner', 'founder', 'c_suite', 'partner', 'director', 'vp', 'head', 'manager'];

export async function find(domain: string): Promise<ApolloFind> {
  const found = await call('mixed_people/api_search', { q_organization_domains_list: [domain], person_seniorities: RANK, page: 1, per_page: 10 }, () => 0);
  const people = ((found.people ?? []) as { id: string; has_email?: boolean }[]).filter(p => p.has_email);
  const out: ApolloFind = { person: null, company: null, checked_at: new Date().toISOString() };
  if (!people.length) return out;
  const r = await call('people/bulk_match', { details: [{ id: people[0].id }], reveal_personal_emails: false, reveal_phone_number: false }, j => j.credits_consumed ?? 1);
  const m = r.matches?.[0];
  if (!m) return out;
  out.person = { name: m.name ?? [m.first_name, m.last_name].filter(Boolean).join(' '), first_name: m.first_name ?? '', title: m.title ?? '',
    email: m.email ?? '', email_status: m.email_status ?? '', linkedin_url: m.linkedin_url ?? '' };
  const o = m.organization;
  if (o) out.company = { employees: o.estimated_num_employees ?? null, founded_year: o.founded_year ?? null, industry: o.industry ?? '',
    description: String(o.short_description ?? '').slice(0, 600), linkedin_url: o.linkedin_url ?? '' };
  return out;
}

// For Claude: who to write to and what the company is like, in one line each.
export function describe(a: ApolloFind | null) {
  if (!a || (!a.person && !a.company)) return 'none';
  const p = a.person, c = a.company;
  return [p && `Decision maker: ${p.name}${p.title ? `, ${p.title}` : ''}`,
    c && [c.employees && `about ${c.employees} staff`, c.founded_year && `founded ${c.founded_year}`, c.industry].filter(Boolean).join(', '),
    c?.description && `About them: ${c.description}`].filter(Boolean).join('\n');
}
