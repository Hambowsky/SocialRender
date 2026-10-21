// The approval queue. A post is stored first, waits for David's approval (unless AUTO_POST is on),
// and is sent to Buffer at most once: a row with a buffer_post_id is never sent again.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { db } from './db.ts';
import { AUTO_POST, fail, PUBLIC_URL } from './config.ts';
import { renderPath } from './render.ts';
import { BufferUnsure, createPost } from './buffer.ts';

export type PostInput = {
  render_id: string;
  channels: { id: string; name?: string }[];
  text: string;
  mode: 'queue' | 'scheduled' | 'draft';
  due_at?: string;
  idempotency_key?: string;
};

type Row = { id: number; render_id: string; channel_id: string; text: string; mode: NewMode; due_at: string | null; status: string; buffer_post_id: string | null };
type NewMode = PostInput['mode'];

const OPEN = ['pending_approval', 'approved', 'sending', 'failed', 'check_buffer'];

export function list(status?: string) {
  return status
    ? db.prepare('SELECT * FROM posts WHERE status = ? ORDER BY id DESC LIMIT 200').all(status)
    : db.prepare(`SELECT * FROM posts WHERE status IN (${OPEN.map(() => '?').join(',')}) OR created_at > datetime('now', '-120 days') ORDER BY id DESC LIMIT 500`).all(...OPEN);
}

const get = (id: number) => (db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as Row | undefined) ?? fail(404, `There is no post ${id}`);

// Same render, text, timing and channel as before: the existing row comes back, so a retry never adds a second post.
export async function create(p: PostInput) {
  if (!fs.existsSync(renderPath(p.render_id))) fail(404, 'That render does not exist or has been cleaned up. Render it again first.');
  if (p.mode === 'scheduled' && !(p.due_at && Date.parse(p.due_at) > Date.now())) fail(400, 'A scheduled post needs a due_at time in the future');
  const key = p.idempotency_key || crypto.createHash('sha256').update(JSON.stringify([p.render_id, p.text, p.mode, p.due_at ?? null])).digest('hex').slice(0, 24);
  const ids: number[] = [];
  for (const c of p.channels) {
    db.prepare(`INSERT INTO posts (idempotency_key, render_id, channel_id, channel_name, text, mode, due_at, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_approval') ON CONFLICT (idempotency_key, channel_id) DO NOTHING`)
      .run(key, p.render_id, c.id, c.name ?? '', p.text, p.mode, p.mode === 'scheduled' ? p.due_at! : null);
    ids.push((db.prepare('SELECT id FROM posts WHERE idempotency_key = ? AND channel_id = ?').get(key, c.id) as { id: number }).id);
  }
  if (AUTO_POST) for (const id of ids) if (get(id).status === 'pending_approval') await approve(id);
  return ids.map(get);
}

export function reject(id: number) {
  const r = db.prepare(`UPDATE posts SET status = 'rejected', decided_at = datetime('now') WHERE id = ? AND status IN ('pending_approval', 'failed', 'check_buffer')`).run(id);
  if (!r.changes) fail(409, `Post ${id} cannot be rejected now (it is ${get(id).status})`);
  return get(id);
}

// After a check_buffer result, David looks in Buffer and tells us whether it went out.
export function markSent(id: number) {
  const r = db.prepare(`UPDATE posts SET status = 'sent', sent_at = datetime('now') WHERE id = ? AND status = 'check_buffer'`).run(id);
  if (!r.changes) fail(409, `Only a post waiting on a Buffer check can be marked as sent`);
  markRenderPosted(get(id));
  return get(id);
}

// Approving sends straight away. Also used to send again after a definite failure, or after
// David has checked Buffer following a check_buffer result.
export async function approve(id: number) {
  if (!PUBLIC_URL) fail(503, 'PUBLIC_URL is not set, so Buffer cannot fetch the image');
  // Claim the row in one statement, so two clicks or two callers can never both send it.
  const claimed = db.prepare(`UPDATE posts SET status = 'sending', decided_at = COALESCE(decided_at, datetime('now')), error = NULL
                              WHERE id = ? AND buffer_post_id IS NULL AND status IN ('pending_approval', 'approved', 'failed', 'check_buffer')`).run(id);
  if (!claimed.changes) fail(409, `Post ${id} cannot be sent now (it is ${get(id).status})`);
  const post = get(id);
  try {
    const bufferId = await createPost({
      channelId: post.channel_id, text: post.text, mode: post.mode, dueAt: post.due_at ?? undefined,
      imageUrl: `${PUBLIC_URL}/public/renders/${post.render_id}.png`,
    });
    db.prepare(`UPDATE posts SET status = 'sent', buffer_post_id = ?, sent_at = datetime('now') WHERE id = ?`).run(bufferId, id);
    markRenderPosted(post);
  } catch (err) {
    const status = err instanceof BufferUnsure ? 'check_buffer' : 'failed';
    db.prepare('UPDATE posts SET status = ?, error = ? WHERE id = ?').run(status, (err as Error).message, id);
    console.error(new Date().toISOString(), `post ${id}`, status, (err as Error).message);
  }
  return get(id);
}

// The image can be cleaned up a few days after it goes out (see cleanup.ts). Drafts never go out by themselves.
function markRenderPosted(post: Row) {
  if (post.mode === 'draft') return;
  db.prepare(`UPDATE renders SET posted_at = MAX(COALESCE(posted_at, ''), datetime(?)) WHERE id = ?`)
    .run(post.mode === 'scheduled' ? post.due_at : new Date().toISOString(), post.render_id);
}
