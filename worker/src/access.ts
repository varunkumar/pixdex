import type { Context, Next } from 'hono';
import type { Env } from './types';

export interface User {
  email: string;
  isDefaultOwner: boolean;
}

/** Resolves the viewer from the proxy-forwarded X-Viewer-Email (checked by requireReadToken). */
export function userOf(c: Context<{ Bindings: Env }>): User {
  const email = (c.req.header('X-Viewer-Email') ?? '').trim().toLowerCase();
  const owner = (c.env.OWNER_EMAIL ?? '').trim().toLowerCase();
  return { email, isDefaultOwner: owner !== '' && email === owner };
}

export async function requireDefaultOwner(c: Context<{ Bindings: Env }>, next: Next) {
  if (!userOf(c).isDefaultOwner) {
    return c.text('Forbidden', 403);
  }
  await next();
}

export type AlbumRole = 'owner' | 'viewer' | null;

/**
 * The user's role on an album. A null album is owned by the default owner only. A named album
 * costs one albums point lookup: NULL owner_email means the default owner; shared_with is matched
 * with json_each in the same statement. An album with no row is the default owner's (it has no
 * owner to contradict), nobody else's.
 */
export async function albumRole(db: D1Database, user: User, album: string | null): Promise<AlbumRole> {
  if (album === null) return user.isDefaultOwner ? 'owner' : null;
  const row = await db
    .prepare(
      'SELECT lower(owner_email) AS owner, EXISTS(SELECT 1 FROM json_each(albums.shared_with) WHERE lower(value) = ?) AS shared FROM albums WHERE name = ?'
    )
    .bind(user.email, album)
    .first<{ owner: string | null; shared: number }>();
  if (!row) return user.isDefaultOwner ? 'owner' : null;
  if (row.owner === null ? user.isDefaultOwner : row.owner === user.email) return 'owner';
  return row.shared ? 'viewer' : null;
}

/**
 * Write routes (non-GET, outside /ingest/*) that carry an authorization check, as "METHOD /path".
 * index.ts fills it through ownerWrite (requireDefaultOwner) and albumWrite (the handler calls
 * albumRole); test/sharing-writes.test.ts fails when a route is missing from it.
 */
export const guardedWrites = new Set<string>();
