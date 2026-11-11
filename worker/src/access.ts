import type { Context } from 'hono';
import type { Env } from './types';

export interface User {
  email: string;
}

/** Resolves the viewer from the proxy-forwarded X-Viewer-Email (checked by requireReadToken). */
export function userOf(c: Context<{ Bindings: Env }>): User {
  return { email: (c.req.header('X-Viewer-Email') ?? '').trim().toLowerCase() };
}

export type AlbumRole = 'owner' | 'viewer' | null;

/**
 * The user's role on an album: owner when albums.owner_email is theirs, viewer when their email is in
 * shared_with, else null. A null album, a missing albums row and an album with no owner (not yet
 * backfilled) belong to nobody. One albums point lookup; shared_with is matched with json_each in
 * the same statement.
 */
export async function albumRole(db: D1Database, user: User, album: string | null): Promise<AlbumRole> {
  if (album === null) return null;
  const row = await db
    .prepare(
      'SELECT owner_email AS owner, EXISTS(SELECT 1 FROM json_each(albums.shared_with) WHERE value = ?) AS shared FROM albums WHERE name = ?'
    )
    .bind(user.email, album)
    .first<{ owner: string | null; shared: number }>();
  if (!row) return null;
  if (row.owner !== null && row.owner === user.email) return 'owner';
  return row.shared ? 'viewer' : null;
}

/**
 * Write routes (non-GET, outside /ingest/*) that carry an authorization check, as "METHOD /path".
 * index.ts fills it through guardedWrite; every handler authorizes itself (albumRole, photoAccess,
 * person ownership). test/sharing-writes.test.ts fails when a route is missing from it.
 */
export const guardedWrites = new Set<string>();
