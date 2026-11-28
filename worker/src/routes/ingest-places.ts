import type { Context } from 'hono';
import * as z from 'zod/mini';
import type { Env } from '../types';
import { placeSchema } from '../db/photos';

const MAX_PHOTOS = 100;

const pendingSchema = z.object({
  cursor: z.optional(z.int().check(z.minimum(0))),
  limit: z.int().check(z.minimum(1), z.maximum(MAX_PHOTOS)),
});

const PENDING_SQL = `SELECT rowid AS cursor, content_hash, latitude, longitude FROM photos
WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND place IS NULL AND rowid > ? ORDER BY rowid LIMIT ?`;

/**
 * Photos with a GPS position and no place yet, paged by rowid, at most 100. One full pass reads each photo row
 * about once; rows written: 0.
 */
export async function pendingPlacesRoute(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json().catch(() => undefined);
  if (body === undefined) return c.json({ error: 'Invalid JSON body' }, 400);
  const parsed = pendingSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: z.flattenError(parsed.error) }, 400);
  const { cursor = 0, limit } = parsed.data;
  const { results } = await c.env.DB.prepare(PENDING_SQL)
    .bind(cursor, limit)
    .all<{ cursor: number; content_hash: string; latitude: number; longitude: number }>();
  return c.json({
    items: results.map((r) => ({ contentHash: r.content_hash, latitude: r.latitude, longitude: r.longitude })),
    nextCursor: results.length === limit ? results[results.length - 1].cursor : null,
  });
}

const placesSchema = z.object({
  photos: z
    .array(z.object({ contentHash: z.string().check(z.minLength(1)), place: placeSchema }))
    .check(z.minLength(1), z.maxLength(MAX_PHOTOS)),
});

/**
 * Sets the place of already-indexed photos by content hash. Per request (at most 100): one lookup by the unique
 * content_hash index and one batched update for each known photo (the FTS trigger rewrites its index row).
 */
export async function ingestPlacesRoute(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json().catch(() => undefined);
  if (body === undefined) return c.json({ error: 'Invalid JSON body' }, 400);
  const parsed = placesSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: z.flattenError(parsed.error) }, 400);

  // The last entry wins when a hash is repeated in one request.
  const byHash = new Map(parsed.data.photos.map((p) => [p.contentHash, p.place]));
  const known = await c.env.DB.prepare('SELECT content_hash FROM photos WHERE content_hash IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify([...byHash.keys()]))
    .all<{ content_hash: string }>();
  const update = c.env.DB.prepare('UPDATE photos SET place = ? WHERE content_hash = ?');
  const statements = known.results.map((r) => update.bind(byHash.get(r.content_hash)!, r.content_hash));
  if (statements.length > 0) await c.env.DB.batch(statements);
  return c.json({ updated: statements.length, unknown: byHash.size - statements.length });
}
