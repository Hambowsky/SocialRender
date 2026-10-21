// Layout check, run inside the page by both the editor preview and the renderer.
// Measures every block inside .post after fonts load and returns problems a caller can act on.
// An empty list means the image is safe to render.
window.layoutErrors = async function () {
  await document.fonts.ready;
  const GAP = 16; // clear space required between blocks, px
  const problems = [...(window.fillProblems || [])];
  const postEl = document.querySelector('.post');
  if (!postEl) return [{ field: null, message: 'Template has no .post element' }];
  // Motion templates animate in, so measure the last frame, then put the animation back where it was.
  const anims = document.getAnimations().filter(a => isFinite(a.effect.getComputedTiming().endTime)).map(a => [a, a.currentTime, a.playState]);
  for (const [a] of anims) { a.pause(); a.currentTime = a.effect.getComputedTiming().endTime; }
  try { return measure(postEl, problems, GAP); }
  finally { for (const [a, t, state] of anims) { a.currentTime = t; if (state === 'running') a.play(); } }
};

function measure(postEl, problems, GAP) {
  const post = postEl.getBoundingClientRect();
  const [w, h] = (postEl.dataset.size || '1080x1080').split('x').map(Number);
  if (Math.round(post.width) !== w || Math.round(post.height) !== h)
    problems.push({ field: null, message: `.post must be ${w} by ${h}, it is ${Math.round(post.width)} by ${Math.round(post.height)}` });
  // Nothing has a size to measure, so every block would look like it overlaps every other one.
  if (!post.width || !post.height) return problems;

  // data-decor marks decoration (snow, confetti) that may sit over or behind other blocks on purpose.
  const blocks = [...postEl.children].filter(el => getComputedStyle(el).display !== 'none' && el.tagName !== 'SCRIPT' && !('decor' in el.dataset));
  const name = el => el.dataset.field || el.className || el.tagName.toLowerCase();

  // Rough characters to cut so `px` of overflow goes away, based on this box's own text.
  function shortenBy(el, px, axis) {
    const len = el.textContent.trim().length || 1;
    if (axis === 'x') return Math.ceil(px / (el.scrollWidth / len));
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || el.getBoundingClientRect().height;
    const lines = Math.max(1, Math.round(el.getBoundingClientRect().height / lineHeight));
    return Math.ceil(Math.ceil(px / lineHeight) * (len / lines));
  }
  function report(el, px, axis, what) {
    px = Math.ceil(px);
    if (!el.dataset.field) return problems.push({ field: null, message: `Template layout problem: ${name(el)} ${what} by ${px}px` });
    const chars = shortenBy(el, px, axis);
    problems.push({ field: el.dataset.field, overflow_px: px, shorten_by_chars: chars,
      message: `${el.dataset.field} ${what} by ${px}px. Shorten it by about ${chars} characters.` });
  }

  for (const el of blocks) {
    const r = el.getBoundingClientRect();
    if (el.scrollWidth > el.clientWidth + 1) report(el, el.scrollWidth - el.clientWidth, 'x', 'is too wide for its space');
    if (r.right > post.right) report(el, r.right - post.right, 'x', 'runs off the right edge');
    if (r.left < post.left) report(el, post.left - r.left, 'x', 'runs off the left edge');
    if (r.bottom > post.bottom) report(el, r.bottom - post.bottom, 'y', 'runs off the bottom');
  }

  for (let i = 0; i < blocks.length; i++) for (let j = i + 1; j < blocks.length; j++) {
    const a = blocks[i].getBoundingClientRect(), b = blocks[j].getBoundingClientRect();
    const x = Math.min(a.right, b.right) - Math.max(a.left, b.left) + GAP;
    const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) + GAP;
    if (x <= 0 || y <= 0) continue;
    const [upper, lower] = a.top <= b.top ? [blocks[i], blocks[j]] : [blocks[j], blocks[i]];
    const [left, right] = a.left <= b.left ? [blocks[i], blocks[j]] : [blocks[j], blocks[i]];
    // Stacked blocks: the upper one has grown down into the lower one. Side by side: the longer text is to blame.
    let culprit, other, axis;
    if (y <= x) [culprit, other, axis] = upper.dataset.field || !lower.dataset.field ? [upper, lower, 'y'] : [lower, upper, 'y'];
    else {
      const byLength = left.textContent.length >= right.textContent.length ? [left, right] : [right, left];
      [culprit, other] = byLength[0].dataset.field || !byLength[1].dataset.field ? byLength : [byLength[1], byLength[0]];
      axis = 'x';
    }
    report(culprit, axis === 'y' ? y : x, axis, `${y <= x ? 'overlaps' : 'runs into'} ${name(other)}`);
  }
  return problems;
}
