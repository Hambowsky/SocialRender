// Templates live in SQLite as versions (see versions.ts). The files in templates/ are seeds.
import path from 'node:path';
import { fail, MAX_FIELD_CHARS, ROOT } from './config.ts';
import { versionStore } from './versions.ts';

export type Problem = { field: string | null; message: string; overflow_px?: number; shorten_by_chars?: number };

const store = versionStore('template_versions', 'template', html => {
  if (!/class="post"/.test(html)) fail(400, 'A template needs an element with class="post"');
});
export const { current, list, versions, save, rollback } = store;
export const seed = () => store.seed(path.join(ROOT, 'templates'), '.html');

// Fields a caller must send, in template order. highlight_word goes with headline.
export function fieldsOf(html: string): string[] {
  const names = [...new Set([...html.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]))];
  const i = names.indexOf('headline');
  if (i >= 0) names.splice(i + 1, 0, 'highlight_word');
  return names;
}

export function sampleOf(html: string): Record<string, string> {
  const m = html.match(/<script type="application\/json" id="sample">([\s\S]*?)<\/script>/);
  return m ? JSON.parse(m[1]) : {};
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Sizes a template can be laid out at, e.g. ["1080x1920", "1080x1080"]. Empty means its one fixed size.
export const sizesOf = (html: string) => html.match(/data-sizes="([^"]+)"/)?.[1].split(/\s+/) ?? [];

// Text only: every value is escaped, so a caller can never change the design.
// `size` picks one of the template's sizes; its CSS lays itself out from .post's data-size.
export function fill(html: string, fields: Record<string, string>, size?: string): { html: string; problems: Problem[] } {
  const problems: Problem[] = [];
  if (size) {
    const sizes = sizesOf(html);
    if (!sizes.includes(size)) fail(400, sizes.length ? `This template comes in ${sizes.join(', ')}` : 'This template comes in one size only');
    html = html.replace(/(<[^>]*class="post"[^>]*data-size=")\d+x\d+"/, `$1${size}"`);
  }
  let out = html.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = String(fields[key] ?? '').trim();
    if (!value) { problems.push({ field: key, message: `${key} is required` }); return ''; }
    if (value.length > MAX_FIELD_CHARS) problems.push({ field: key, message: `${key} is over ${MAX_FIELD_CHARS} characters` });
    if (key !== 'headline') return esc(value);

    let headline = esc(value).replace(/\r?\n/g, '<br>');
    const word = String(fields.highlight_word ?? '').trim();
    if (word) {
      const re = new RegExp(`(?<![\\w])(${escRe(esc(word))})(?![\\w])`, 'i');
      if (re.test(headline)) headline = headline.replace(re, '<span class="hl">$1</span>');
      else problems.push({ field: 'highlight_word', message: `highlight_word "${word}" is not in the headline` });
    }
    return headline;
  });
  const inject = `<script>window.fillProblems = ${JSON.stringify(problems).replace(/</g, '\\u003c')}</script>\n<script src="/check.js"></script>\n</head>`;
  out = out.replace('</head>', inject);
  return { html: out, problems };
}
