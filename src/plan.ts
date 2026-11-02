// The week's content in one go: an article idea from research, its sources, the draft, then a few social posts
// spread over the weekdays: Monday's comes from the article, the rest each take another of the research ideas
// so the week is not all one topic. Everything waits for David: the article in the review list,
// the posts in the approval list. The posts do not link to the article, since it is not live yet.
import { db } from './db.ts';
import { fail } from './config.ts';
import { categories, draft, findSources, research } from './articles.ts';
import { writeCopy } from './copy.ts';
import { render } from './render.ts';
import * as posts from './posts.ts';

export type PlanInput = { category?: string; channels: posts.PostInput['channels']; count?: number; focus?: string; again?: boolean };

const TEMPLATES = ['social-post', 'tip-card', 'stat-card', 'quote-card', 'social-post'];
const DAYS: Record<number, number[]> = { 3: [0, 2, 4], 4: [0, 1, 3, 4], 5: [0, 1, 2, 3, 4] }; // Monday is 0

// Next Monday, as a date, so a plan made any day of the week covers the coming week.
export function nextMonday(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + (((8 - d.getUTCDay()) % 7) || 7));
  return d.toISOString().slice(0, 10);
}

// 10am UK time on a date, whether or not the clocks have gone forward.
export function tenAmLondon(date: string) {
  const noonUtc = new Date(`${date}T12:00:00Z`);
  const offset = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', timeZoneName: 'shortOffset' }).formatToParts(noonUtc)
    .find(p => p.type === 'timeZoneName')!.value; // GMT or GMT+1
  const hours = Number(offset.replace('GMT', '') || 0);
  return new Date(Date.parse(`${date}T10:00:00Z`) - hours * 3600_000).toISOString();
}

// Categories take turns, one a week, so the site grows evenly.
function categoryFor(monday: string) {
  const all = categories().map(c => c.category);
  if (!all.length) fail(400, 'There are no article prompts, so there is nothing to plan');
  return all[Math.floor(Date.parse(monday) / (7 * 86_400_000)) % all.length];
}

export function savedPlan() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(`plan:${nextMonday()}`) as { value: string } | undefined;
  return { week_of: nextMonday(), plan: row ? JSON.parse(row.value) : null };
}

let planning = false;
export async function planWeek(input: PlanInput) {
  if (!input.channels?.length) fail(400, 'Pick at least one Buffer channel for the posts');
  const monday = nextMonday();
  const key = `plan:${monday}`;
  const saved = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (saved && !input.again) return { ...JSON.parse(saved.value), reused: true };
  if (planning) fail(409, 'A week is already being planned');
  planning = true;
  try {
    const count = Math.min(5, Math.max(3, input.count ?? 4));
    const category = input.category || categoryFor(monday);
    let cost = 0;
    const ideas = await research(category, { focus: input.focus });
    cost += ideas.cost_gbp;
    const idea = ideas.ideas[0] ?? fail(502, 'Claude did not come back with an article idea. Try again');
    const sources = await findSources(category, { topic: idea.title, keyword: idea.keyword, audience: idea.audience });
    cost += sources.cost_gbp;
    const article = await draft({ topic: idea.title, keyword: idea.keyword, audience: idea.audience, sources: sources.text, category });
    cost += article.cost_gbp;

    const made: { id: number; template: string; headline: string; due_at: string }[] = [];
    const problems: string[] = [];
    for (let i = 0; i < count; i++) {
      const template = TEMPLATES[i % TEMPLATES.length];
      const date = new Date(Date.parse(monday) + DAYS[count][i] * 86_400_000).toISOString().slice(0, 10);
      const done = made.map(m => `"${m.headline}"`).join(', ');
      const other = i > 0 ? ideas.ideas[i] : undefined; // research gives six ideas; the article used the first
      try {
        const copy = await writeCopy({ template, ...(other
          ? { keyword: other.keyword, sources: other.notes,
              topic: `${other.title}. ${other.angle} Take one single, useful point from this${done ? `, different from the posts already made this week: ${done}` : ''}. Do not mention an article or a link.` }
          : { keyword: article.keyword, sources: article.body,
              topic: `Drawn from our new article "${article.title}". Take one single, useful point from it`
                + `${done ? `, different from the posts already made: ${done}` : ''}. The article is not live yet, so do not mention a link to it.` }) });
        cost += copy.cost_gbp;
        if (!copy.fits) { problems.push(`Post ${i + 1}: the text did not fit ${template}`); continue; }
        const r = await render(template, copy.fields);
        if (!r.ok) { problems.push(`Post ${i + 1}: the text did not fit ${template}`); continue; }
        const due = tenAmLondon(date);
        const [p] = await posts.create({ render_id: r.id, channels: input.channels, text: [copy.caption, copy.hashtags.join(' ')].join('\n\n'),
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
