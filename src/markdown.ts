// Just enough Markdown for articles: headings, paragraphs, bullet lists, quotes, bold, italic, links and rules.
export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Quotes stay as typed in text; link targets cannot contain them, so attributes stay safe.
export const inline = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s"]+|\/[^)\s"]*)\)/g, '<a href="$2">$1</a>')
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
    else if (b.split('\n').every(l => /^\s*[-*]\s+/.test(l))) out.push(`<ul>\n${b.split('\n').map(l => `  <li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('\n')}\n</ul>`);
    else out.push(`<p>${b.split('\n').map(inline).join('<br>\n')}</p>`);
  }
  return out.join('\n').replace(/\n(<h[23]>)/g, '\n\n$1');
}
