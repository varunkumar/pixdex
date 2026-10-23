import type { Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';

const requestSchema = z.object({
  from: z.string().min(2).startsWith('/'),
  to: z.string().min(2).startsWith('/'),
  dryRun: z.boolean().optional(),
});

/**
 * Re-points local photos from one folder to another after the folder was moved
 * on disk: every `path` equal to `from` or under `from/` gets `from` replaced
 * by `to`. Only `path` changes (content hash, album and owner edits stay), and
 * the match is on whole path segments so `/a/abc` never catches `/a/abcd`.
 * With `dryRun` it only reports how many photos would move.
 */
export async function ingestRelocateRoute(c: Context<{ Bindings: Env }>) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }
  const from = parsed.data.from.replace(/\/+$/, '');
  const to = parsed.data.to.replace(/\/+$/, '');
  if (!from || !to) {
    return c.json({ error: 'from and to must not be the filesystem root' }, 400);
  }

  const match = `source = 'local' AND (path = ?1 OR substr(path, 1, length(?1) + 1) = ?1 || '/')`;

  // Counted separately: meta.changes also includes the FTS rows the update trigger rewrites.
  const row = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM photos WHERE ${match}`)
    .bind(from)
    .first<{ n: number }>();
  const matched = row?.n ?? 0;
  if (parsed.data.dryRun || matched === 0) {
    return c.json({ matched, updated: 0 });
  }

  await c.env.DB.prepare(`UPDATE photos SET path = ?2 || substr(path, length(?1) + 1) WHERE ${match}`)
    .bind(from, to)
    .run();
  return c.json({ matched, updated: matched });
}
