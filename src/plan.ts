// The week's content in one go: an article idea from research, its sources, the draft, then a few social posts
// spread over the whole week: the first comes from the new article, the rest each promote a guide already live
// on the site from another category (linking to it), so the week covers different topics. With no other guides,
// they fall back to the other research ideas. Everything waits for David: the article in the review list,
// the posts in the approval list. The posts do not link to the article, since it is not live yet.
import { db } from './db.ts';
import { fail, SITE_URL } from './config.ts';
import { categories, draft, findSources, research, siteGuides } from './articles.ts';
import { writeCopy } from './copy.ts';
import { render } from './render.ts';
import * as posts from './posts.ts';

export type PlanInput = { category?: string; channels: posts.PostInput['channels']; count?: number; focus?: string; again?: boolean; week?: 'this' | 'next' };

const TEMPLATES = ['social-post', 'tip-card', 'stat-card', 'quote-card', 'social-post'];

// Next Monday, as a date, so a plan made any day of the week covers the coming week.
export function nextMonday(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + (((8 - d.getUTCDay()) % 7) || 7));
  return d.toISOString().slice(0, 10);
}

// Monday of the current week. On a Sunday that is six days ago, so nothing is left to plan.
export function thisMonday(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

// Times for the posts across the whole week (Monday is day 0), only those still to come. Up to one a day they
// go out at 10am on evenly spread days (3 is Mon, Thu, Sun); beyond that every day gets 10am and some also 3pm.
export function postTimes(monday: string, count: number, now = new Date()) {
  const soon = now.getTime() + 15 * 60_000;
  const left = [0, 1, 2, 3, 4, 5, 6].filter(d => Date.parse(atLondon(dayOf(monday, d), 10)) > soon);
  const spread = <T>(list: T[], n: number) => list.length <= n ? list : n === 1 ? [list[0]] : Array.from({ length: n }, (_, i) => list[Math.round(i * (list.length - 1) / (n - 1))]);
  const mornings = spread(left, count);
  const afternoons = spread(left.filter(d => Date.parse(atLondon(dayOf(monday, d), 15)) > soon), Math.max(0, count - left.length));
  return [...mornings.map(d => atLondon(dayOf(monday, d), 10)), ...afternoons.map(d => atLondon(dayOf(monday, d), 15))].sort();
}
const dayOf = (monday: string, d: number) => new Date(Date.parse(monday) + d * 86_400_000).toISOString().slice(0, 10);

// A UK clock time on a date, whether or not the clocks have gone forward.
export const tenAmLondon = (date: string) => atLondon(date, 10);
export function atLondon(date: string, hour: number) {
  const noonUtc = new Date(`${date}T12:00:00Z`);
  const offset = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', timeZoneName: 'shortOffset' }).formatToParts(noonUtc)
    .find(p => p.type === 'timeZoneName')!.value; // GMT or GMT+1
  const hours = Number(offset.replace('GMT', '') || 0);
  return new Date(Date.parse(`${date}T12:00:00Z`) + (hour - 12 - hours) * 3600_000).toISOString();
}

// Categories take turns, one a week, so the site grows evenly.
function categoryFor(monday: string) {
  const all = categories().map(c => c.category);
  if (!all.length) fail(400, 'There are no article prompts, so there is nothing to plan');
  return all[Math.floor(Date.parse(monday) / (7 * 86_400_000)) % all.length];
}

const saved = (monday: string) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(`plan:${monday}`) as { value: string } | undefined;
  if (!row) return { week_of: monday, plan: null };
  // The saved plan with where each part stands now, so the card follows David's approvals and rejections.
  const plan = JSON.parse(row.value);
  plan.article.status = (db.prepare('SELECT status FROM articles WHERE id = ?').get(plan.article.id) as { status: string } | undefined)?.status ?? 'deleted';
  const status = db.prepare('SELECT status FROM posts WHERE id = ?');
  for (const p of plan.posts) p.status = (status.get(p.id) as { status: string } | undefined)?.status ?? 'deleted';
  return { week_of: monday, plan };
};
export function savedPlan() {
  return { ...saved(nextMonday()), this_week: saved(thisMonday()) };
}

type Guide = { category: string; slug: string };
// Live guides from other categories, one category after another, starting somewhere different each week.
export function otherGuides<G extends Guide>(all: G[], category: string, week: number, n: number) {
  const cats = [...new Set(all.filter(g => g.category !== category).map(g => g.category))].sort();
  const picks: G[] = [];
  for (let round = 0; picks.length < n && round < all.length; round++)
    for (let c = 0; c < cats.length && picks.length < n; c++) {
      const list = all.filter(g => g.category === cats[(c + week) % cats.length]).sort((a, b) => a.slug.localeCompare(b.slug));
      const g = list[(week + round) % list.length];
      if (!picks.includes(g)) picks.push(g);
    }
  return picks;
}

let planning = false;
export async function planWeek(input: PlanInput) {
  if (!input.channels?.length) fail(400, 'Pick at least one Buffer channel for the posts');
  const monday = input.week === 'this' ? thisMonday() : nextMonday();
  const key = `plan:${monday}`;
  const before = saved(monday).plan;
  if (before && !input.again) return { ...before, reused: true };
  const times = postTimes(monday, Math.min(14, Math.max(1, input.count ?? 4)));
  if (!times.length) fail(400, 'There are no days left this week. Plan next week instead');
  if (planning) fail(409, 'A week is already being planned');
  planning = true;
  try {
    const count = times.length;
    const category = input.category || categoryFor(monday);
    let cost = 0;
    const ideas = await research(category, { focus: input.focus });
    cost += ideas.cost_gbp;
    const idea = ideas.ideas[0] ?? fail(502, 'Claude did not come back with an article idea. Try again');
    const sources = await findSources(category, { topic: idea.title, keyword: idea.keyword, audience: idea.audience });
    cost += sources.cost_gbp;
    const article = await draft({ topic: idea.title, keyword: idea.keyword, audience: idea.audience, sources: sources.text, category });
    cost += article.cost_gbp;

    const guides = otherGuides(await siteGuides(), category, Math.floor(Date.parse(monday) / (7 * 86_400_000)), count - 1);
    const made: { id: number; template: string; headline: string; due_at: string }[] = [];
    const problems: string[] = [];
    for (let i = 0; i < count; i++) {
      const template = TEMPLATES[i % TEMPLATES.length];
      const done = made.map(m => `"${m.headline}"`).join(', ');
      const guide = i > 0 ? guides[i - 1] : undefined;
      const url = guide && `${SITE_URL}${guide.category}${guide.slug}`;
      const spare = ideas.ideas.slice(1); // research gives six ideas; the article used the first
      const other = i > 0 && !guide && spare.length ? spare[(i - 1 - guides.length) % spare.length] : undefined;
      try {
        const copy = await writeCopy({ template, ...(url ? { url } : other
          ? { keyword: other.keyword, sources: other.notes,
              topic: `${other.title}. ${other.angle} Take one single, useful point from this${done ? `, different from the posts already made this week: ${done}` : ''}. Do not mention an article or a link.` }
          : { keyword: article.keyword, sources: article.body,
              topic: `Drawn from our new article "${article.title}". Take one single, useful point from it`
                + `${done ? `, different from the posts already made: ${done}` : ''}. The article is not live yet, so do not mention a link to it.` }) });
        cost += copy.cost_gbp;
        if (!copy.fits) { problems.push(`Post ${i + 1}: the text did not fit ${template}`); continue; }
        const r = await render(template, copy.fields);
        if (!r.ok) { problems.push(`Post ${i + 1}: the text did not fit ${template}`); continue; }
        const due = times[i];
        const [p] = await posts.create({ render_id: r.id, channels: input.channels, text: [copy.caption, url, copy.hashtags.join(' ')].filter(Boolean).join('\n\n'),
          mode: 'scheduled', due_at: due, idempotency_key: `plan-${article.id}-${i}` });
        made.push({ id: p.id, template, headline: copy.fields.headline, due_at: due });
      } catch (err) {
        problems.push(`Post ${i + 1}: ${(err as Error).message}`);
      }
    }

    const result = { week_of: monday, category, article: { id: article.id, title: article.title, category }, posts: made, problems, cost_gbp: +cost.toFixed(2) };
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(key, JSON.stringify(result));
    return result;
  } finally {
    planning = false;
  }
}
