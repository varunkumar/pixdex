import type { Context } from 'hono';
import * as z from 'zod/mini';
import { albumRole, userOf } from '../access';
import { photoAccess } from '../db/visibility';
import type { Env } from '../types';

/** GET /me: the resolved viewer. No D1 access, constant CPU. */
export function meRoute(c: Context<{ Bindings: Env }>) {
  return c.json({ email: userOf(c).email });
}

const MAX_SHARES = 50;
const sharesBody = z.object({
  album: z.string().check(z.minLength(1)),
  emails: z.array(z.string().check(z.trim(), z.toLowerCase(), z.email())).check(z.maxLength(MAX_SHARES)),
});

/**
 * PUT /albums/shares: replaces an album's shared_with. Owner only (404 no access, 403 viewer).
 * Always writes valid JSON (or NULL), because json_each over malformed text would fail every scoped query.
 * D1: 1 albums point read (albumRole) + 1 write (albums.shared_with, one row).
 */
export async function putAlbumSharesRoute(c: Context<{ Bindings: Env }>) {
  const parsed = sharesBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: z.flattenError(parsed.error) }, 400);
  const { album } = parsed.data;
  const emails = [...new Set(parsed.data.emails)];

  const role = await albumRole(c.env.DB, userOf(c), album);
  if (role === null) return c.text('Not Found', 404);
  if (role !== 'owner') return c.text('Forbidden', 403);

  const res = await c.env.DB.prepare('UPDATE albums SET shared_with = ? WHERE name = ?')
    .bind(emails.length ? JSON.stringify(emails) : null, album)
    .run();
  if (!res.meta.changes) return c.text('Not Found', 404);
  return c.json({ album, emails });
}

/** GET /access/photo/:id: 204 when the caller may see the photo, else 404. Same cost as getPhotoRoute's lookup. */
export async function accessPhotoRoute(c: Context<{ Bindings: Env }>) {
  const access = photoAccess(userOf(c), 'p');
  const row = await c.env.DB.prepare(`SELECT 1 AS ok FROM photos p${access.join} WHERE p.id = ?${access.where}`)
    .bind(c.req.param('id'), ...access.params)
    .first();
  return row ? c.body(null, 204) : c.text('Not Found', 404);
}
