// Deletes render files that are posted, or unposted and older than RENDER_RETENTION_DAYS.
// The database row stays (with deleted_at) so a later identical request simply renders again.
import fs from 'node:fs';
import { db } from './db.ts';
import { RENDER_RETENTION_DAYS } from './config.ts';
import { renderPath } from './render.ts';

export function cleanup(): number {
  const rows = db.prepare(`SELECT id FROM renders WHERE deleted_at IS NULL
                           AND (posted_at IS NOT NULL OR created_at < datetime('now', ?))`)
    .all(`-${RENDER_RETENTION_DAYS} days`) as { id: string }[];
  for (const { id } of rows) {
    fs.rmSync(renderPath(id), { force: true });
    db.prepare(`UPDATE renders SET deleted_at = datetime('now') WHERE id = ?`).run(id);
  }
  return rows.length;
}

export function startCleanup() {
  cleanup();
  setInterval(cleanup, 60 * 60 * 1000).unref();
}
