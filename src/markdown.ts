// Just enough Markdown for articles: headings, paragraphs, bullet and numbered lists, quotes, bold, italic, links and rules.
export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Quotes stay as typed in text; link targets cannot contain them, so attributes stay safe.
export const inline = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s"]+|\/[^)\s"]*)\)/g, (_, t: string, href: string) =>
    /^https?:\/\/(www\.)?redcherryit\.com(\/|$)/.test(href) || href.startsWith('/') ? `<a href="${href}">${t}</a>` : `<a href="${href}" target="_blank" rel="noopener">${t}</a>`)
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<em>$2</em>');

export function toHtml(md: string) {
  const out: string[] = [];
  for (const block of md.replace(/\r/g, '').split(/\n\s*\n/)) {
    const b = block.trim();
    if (!b) continue;
    const h = b.match(/^(#{1,4})\s+(.*)$/);
    if (h && !b.includes('\n')) out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    else if (/^(-{3,}|\*{3,})$/.test(b)) out.push('<hr>');
    else if (b.split('\n').every(l => l.startsWith('>'))) out.push(`<blockquote>${b.split('\n').map(l => inline(l.replace(/^>\s?/, ''))).join('<br>\n')}</blockquote>`);
    else if (b.split('\n').every(l => /^\s*\d+\.\s+/.test(l))) out.push(`<ol>\n${b.split('\n').map(l => `  <li>${inline(l.replace(/^\s*\d+\.\s+/, ''))}</li>`).join('\n')}\n</ol>`);
    else if (b.split('\n').every(l => /^\s*[-*]\s+/.test(l))) out.push(`<ul>\n${b.split('\n').map(l => `  <li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('\n')}\n</ul>`);
    else out.push(`<p>${b.split('\n').map(inline).join('<br>\n')}</p>`);
  }
  return out.join('\n').replace(/\n(<h[23]>)/g, '\n\n$1');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c', pound: '\u00a3', middot: '\u00b7', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013' };
export const unesc = (s: string) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) =>
  e[0] === '#' ? String.fromCodePoint(parseInt(e.slice(e[1] === 'x' ? 2 : 1), e[1] === 'x' ? 16 : 10)) : ENTITIES[e.toLowerCase()] ?? m);

// The reverse of toHtml, for importing pages already on the site. Relative links become full addresses.
// Questions under an FAQs heading become bold lines, the way drafts write them.
export function fromHtml(html: string, pageUrl: string) {
  const text = (h: string) => unesc(h
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, t: string) => `[${t}](${new URL(unesc(href), pageUrl).href})`)
    .replace(/<\/?(strong|b)>/gi, '**').replace(/<\/?(em|i)>/gi, '*').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')).replace(/[ \t\r\n]+/g, ' ').trim();
  const out: string[] = [];
  let faq = false;
  for (const [, tag, inner] of html.matchAll(/<(h[1-4]|p|ul|ol|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const t = tag.toLowerCase();
    if (t === 'h2') faq = /^FAQs?$/i.test(text(inner));
    if (t === 'h3' && faq) out.push(`**${text(inner)}**`);
    else if (t[0] === 'h') out.push(`${'#'.repeat(Number(t[1]))} ${text(inner)}`);
    else if (t === 'ul' || t === 'ol') out.push([...inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m, i) => `${t === 'ol' ? `${i + 1}.` : '*'} ${text(m[1])}`).join('\n'));
    else if (t === 'blockquote') out.push((inner.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) ?? [inner]).map(q => `> ${text(q)}`).join('\n'));
    else if (faq && out.at(-1)?.startsWith('**') && !out.at(-1)!.includes('\n')) out[out.length - 1] += `\n${text(inner)}`;
    else out.push(text(inner));
  }
  return out.filter(b => b.replace(/[#*>\s]/g, '')).join('\n\n');
}
