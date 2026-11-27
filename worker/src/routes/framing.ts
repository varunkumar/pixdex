import type { Context } from 'hono';
import * as z from 'zod/mini';
import { albumRole, userOf } from '../access';
import { MAX_ZOOM } from '../db/framing';
import type { Env } from '../types';

const percent = z.number().check(z.minimum(0), z.maximum(100));
const framingBody = z.object({
  album: z.string().check(z.minLength(1)),
  contentHash: z.string().check(z.minLength(1)),
  x: percent,
  y: percent,
  zoom: z.number().check(z.minimum(1), z.maximum(MAX_ZOOM)),
});

/**
 * PUT /albums/framing: saves how the album's cover sits in the banner. Owner only (404 no access, 403 viewer).
 * 409 when contentHash is not the current cover's. The centre at 1x is stored as NULL.
 * D1: 1 albums point read (albumRole) + 1 write (albums.cover_framing, one row).
 */
export async function putAlbumFramingRoute(c: Context<{ Bindings: Env }>) {
  const parsed = framingBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: z.flattenError(parsed.error) }, 400);
  const { album, contentHash, x, y, zoom } = parsed.data;

  const role = await albumRole(c.env.DB, userOf(c), album);
  if (role === null) return c.text('Not Found', 404);
  if (role !== 'owner') return c.text('Forbidden', 403);

  const coverFraming = x === 50 && y === 50 && zoom === 1 ? null : { x, y, zoom };
  // The cover check is part of the write, so a cover changed in between cannot take this framing.
  const res = await c.env.DB.prepare('UPDATE albums SET cover_framing = ? WHERE name = ? AND content_hash = ?')
    .bind(coverFraming && JSON.stringify({ hash: contentHash, ...coverFraming }), album, contentHash)
    .run();
  if (!res.meta.changes) return c.json({ error: 'The album cover has changed' }, 409);
  return c.json({ album, coverFraming });
}
