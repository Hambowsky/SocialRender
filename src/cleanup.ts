// Deletes render files three days after they were posted (Buffer has fetched them by then), or unposted
// ones older than RENDER_RETENTION_DAYS. A render that a post still waits on is never deleted.
// The database row stays (with deleted_at) so a later identical request simply renders again.
import fs from 'node:fs';
import { db } from './db.ts';
import { RENDER_RETENTION_DAYS } from './config.ts';
import { renderPath } from './render.ts';

export function cleanup(): number {
  const rows = db.prepare(`SELECT id FROM renders WHERE deleted_at IS NULL
                           AND (posted_at < datetime('now', '-3 days') OR (posted_at IS NULL AND created_at < datetime('now', ?)))
                           AND id NOT IN (SELECT render_id FROM posts WHERE status NOT IN ('sent', 'rejected'))`)
    .all(`-${RENDER_RETENTION_DAYS} days`) as { id: string }[];
  for (const { id } of rows) {
    fs.rmSync(renderPath(id), { force: true });
    fs.rmSync(renderPath(id, 'mp4'), { force: true });
    db.prepare(`UPDATE renders SET deleted_at = datetime('now') WHERE id = ?`).run(id);
  }
  return rows.length;
}

export function startCleanup() {
  cleanup();
  setInterval(cleanup, 60 * 60 * 1000).unref();
}
