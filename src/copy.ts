// Claude copywriting: editable prompts (versioned like templates) and the copy job that writes
// the text for a template, checks it fits, and writes a caption to go with it.
import fs from 'node:fs';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { fail, ROOT } from './config.ts';
import { versionStore } from './versions.ts';
import { ask, type Ask } from './claude.ts';
import { checkFit, checkHtml } from './render.ts';
import { current as currentTemplate, fieldsOf, list as listTemplates, sampleOf, type Problem } from './templates.ts';
import { NAME_PATTERN } from './versions.ts';
import { readPage } from './page.ts';

const PROMPTS_DIR = path.join(ROOT, 'prompts');

const store = versionStore('prompt_versions', 'prompt', body => parsePrompt(body));
export const { current, list, versions, save, rollback } = store;
export const seed = () => store.seed(PROMPTS_DIR, '.md');

// A prompt file may start with settings between --- lines: model, effort, max_tokens.
export function parsePrompt(body: string) {
  const m = body.match(/^---\n([\s\S]*?)\n---\n?/);
  const settings = Object.fromEntries((m?.[1] ?? '').split('\n').filter(l => l.includes(':')).map(l => {
    const i = l.indexOf(':');
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }));
  if (settings.effort && !['low', 'medium', 'high'].includes(settings.effort)) fail(400, 'effort must be low, medium or high');
  // ponytail: calls are not streamed, which caps max_tokens at 16000. Stream in claude.ts if a prompt ever needs more.
  if (settings.max_tokens && !(Number(settings.max_tokens) > 0 && Number(settings.max_tokens) <= 16000)) fail(400, 'max_tokens must be between 1 and 16000');
  return {
    model: settings.model || 'claude-sonnet-5-5',
    effort: (settings.effort || 'medium') as Ask['effort'],
    maxTokens: Number(settings.max_tokens || 4000),
    text: m ? body.slice(m[0].length) : body,
  };
}

export const varsOf = (body: string) => [...new Set([...parsePrompt(body).text.matchAll(/\{(\w+)\}/g)].map(m => m[1]))];

// Single pass, so text inside a value is never treated as a placeholder.
const fillVars = (text: string, vars: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? '').trim() || '(none given)');

function systemPrompt() {
  const dir = path.join(PROMPTS_DIR, 'examples');
  const examples = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(f => f.endsWith('.md')).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n\n---\n\n')
    : '';
  return fillVars(parsePrompt(current('brand-voice').body).text, { examples });
}

const str = { type: 'string' };
const SCHEMAS: Record<string, Record<string, unknown>> = {
  'social-post': {
    type: 'object', additionalProperties: false,
    required: ['headline', 'highlight_word', 'subtitle', 'tag', 'footer_left'],
    properties: { headline: str, highlight_word: str, subtitle: str, tag: str, footer_left: str },
  },
  'template-design': {
    type: 'object', additionalProperties: false,
    required: ['name', 'html'],
    properties: { name: str, html: str },
  },
  caption: {
    type: 'object', additionalProperties: false,
    required: ['caption', 'hashtags'],
    properties: { caption: str, hashtags: { type: 'array', items: str } },
  },
};

// Runs one prompt. `body` lets the editor test unsaved prompt text; nothing is posted or queued.
// `followUp` continues an earlier run of the same prompt with one more message.
export async function runPrompt(name: string, vars: Record<string, string>,
  opts: { body?: string; job?: string; followUp?: { history: Anthropic.MessageParam[]; note: string } } = {}) {
  const schema = SCHEMAS[name] ?? fail(400, `${name} is not a prompt that can be run on its own`);
  const p = parsePrompt(opts.body ?? current(name).body);
  const messages: Anthropic.MessageParam[] = opts.followUp
    ? [...opts.followUp.history, { role: 'user', content: opts.followUp.note }]
    : [{ role: 'user', content: fillVars(p.text, vars) }];
  const result = await ask({ job: opts.job ?? `test:${name}`, model: p.model, effort: p.effort, maxTokens: p.maxTokens, system: systemPrompt(), messages, schema });
  return { ...result, messages };
}

// Template facts the social post prompt needs: what it is, and sample text that fits.
export function templateVars(template: string) {
  const html = currentTemplate(template).body;
  const sample = sampleOf(html);
  return {
    template: `${template} (fields: ${fieldsOf(html).join(', ')})`,
    sample: JSON.stringify(Object.fromEntries(Object.entries(sample).filter(([k]) => k !== 'footer_right')), null, 2),
    footer_right: sample.footer_right ?? 'redcherryit.com',
  };
}

export type CopyInput = { template: string; topic?: string; url?: string; keyword?: string; audience?: string; sources?: string };

export async function writeCopy(input: CopyInput) {
  const t = templateVars(input.template);
  if (!input.topic?.trim() && !input.url) fail(400, 'Give a topic or a page link');
  // A page link is read here and handed to Claude as a source, so its facts can be used and quoted.
  const page = input.url ? await readPage(input.url) : undefined;
  const vars = { ...input, ...t } as Record<string, string>;
  if (page) {
    vars.topic = input.topic?.trim() || `The page "${page.title || page.url}". Write a post that makes people want to read it.`;
    vars.sources = [input.sources, `From ${page.url}\nTitle: ${page.title}\n${page.description}\n\n${page.text}`].filter(Boolean).join('\n\n');
  }
  let cost = 0;

  let run = await runPrompt('social-post', vars, { job: 'copy:social-post' });
  cost += run.cost_gbp;
  let fields: Record<string, string> = { ...run.output, footer_right: t.footer_right };
  let problems: Problem[] = await checkFit(input.template, fields);

  // One rewrite if it does not fit, telling Claude exactly what to shorten.
  if (problems.length) {
    const history: Anthropic.MessageParam[] = [...run.messages, { role: 'assistant', content: run.content }];
    const note = `That text does not fit the template:\n${problems.map(p => `* ${p.message}`).join('\n')}\nRewrite it shorter so it fits. Keep highlight_word copied exactly from the headline.`;
    run = await runPrompt('social-post', {}, { job: 'copy:social-post:retry', followUp: { history, note } });
    cost += run.cost_gbp;
    fields = { ...run.output, footer_right: t.footer_right };
    problems = await checkFit(input.template, fields);
  }

  const cap = await runPrompt('caption', { ...vars, ...fields }, { job: 'copy:caption' });
  cost += cap.cost_gbp;
  return { template: input.template, page: page && { url: page.url, title: page.title }, fields, fits: problems.length === 0, problems, caption: cap.output.caption, hashtags: cap.output.hashtags, cost_gbp: cost };
}

const ALLOWED_FIELDS = ['headline', 'highlight_word', 'subtitle', 'tag', 'footer_left', 'footer_right'];

// Rule checks that need no browser. The layout check runs after these.
function designProblems(name: string, html: string): Problem[] {
  const out: string[] = [];
  if (!new RegExp(NAME_PATTERN).test(name)) out.push('name must use lowercase letters, numbers and hyphens only');
  if ((listTemplates() as { name: string }[]).some(t => t.name === name)) out.push(`a template called ${name} already exists, pick another name`);
  if (!/class="post"/.test(html)) out.push('there is no element with class="post"');
  const fields = fieldsOf(html);
  if (!fields.includes('headline')) out.push('there is no {{headline}} placeholder');
  const extra = fields.filter(f => !ALLOWED_FIELDS.includes(f));
  if (extra.length) out.push(`these placeholders are not allowed: ${extra.join(', ')}`);
  if (/<script(?![^>]*id="sample")/i.test(html)) out.push('it contains JavaScript');
  if (/(src|href)\s*=\s*["']?(https?:)?\/\//i.test(html) || /url\(\s*["']?(https?:)?\/\//i.test(html)) out.push('it loads something from outside the app');
  let sample: Record<string, string> = {};
  try { sample = sampleOf(html); } catch { out.push('the sample script is not valid JSON'); }
  const missing = fields.filter(f => f !== 'highlight_word' && !String(sample[f] ?? '').trim());
  if (missing.length) out.push(`the sample text is missing: ${missing.join(', ')}`);
  return out.map(message => ({ field: null, message }));
}

// Claude designs a new template. Nothing is saved: the editor loads it for David to preview and save.
export async function designTemplate(input: { description: string; base: string }) {
  const vars = { description: input.description, base: currentTemplate(input.base).body };
  let cost = 0;
  let run = await runPrompt('template-design', vars, { job: 'design:template' });
  cost += run.cost_gbp;

  const check = async (o: { name: string; html: string }) => {
    const rules = designProblems(o.name, o.html);
    return rules.length ? rules : checkHtml(o.html, sampleOf(o.html));
  };
  let problems = await check(run.output);

  // One fix up round, telling Claude exactly what is wrong.
  if (problems.length) {
    const history: Anthropic.MessageParam[] = [...run.messages, { role: 'assistant', content: run.content }];
    const note = `That template cannot be used yet:\n${problems.map(p => `* ${p.message}`).join('\n')}\nFix these and return the whole template again.`;
    run = await runPrompt('template-design', {}, { job: 'design:template:retry', followUp: { history, note } });
    cost += run.cost_gbp;
    problems = await check(run.output);
  }
  return { name: run.output.name, html: run.output.html, sample: problems.length ? {} : sampleOf(run.output.html), ok: problems.length === 0, problems, cost_gbp: cost };
}
