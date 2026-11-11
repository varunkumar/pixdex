import type { User } from '../access';

export interface Scope {
  sql: string;
  params: unknown[];
}

/**
 * Subquery of album names the user may see: owned (owner_email = them, an index search on
 * idx_albums_owner_email) or shared with them. There is no default owner: an album with a NULL
 * owner is visible to nobody until the one-time backfill stamps it.
 */
export function visibleAlbumsSql(user: User): Scope {
  return {
    sql: '(SELECT name FROM albums WHERE owner_email = ? OR EXISTS (SELECT 1 FROM json_each(albums.shared_with) WHERE value = ?))',
    params: [user.email, user.email],
  };
}

/** AND-clause limiting `column` (a photos album column) to the user's visible albums. Photos with no album match nothing. */
export function scopeFor(user: User, column: string): Scope {
  const v = visibleAlbumsSql(user);
  return { sql: ` AND ${column} IN ${v.sql}`, params: v.params };
}

export interface PhotoAccess {
  join: string;
  where: string;
  params: unknown[];
}

/**
 * Single-photo visibility as a primary-key join on albums, for point lookups (one photo by id, content
 * hash or face). Unlike scopeFor it never scans albums: append `join` after the FROM clause that names
 * the photos alias passed as `p`, and `where` (an AND-clause) after the photo key. The joined album is aliased
 * `va`, so `va.owner_email` is selectable. A photo with no album, or whose album has no albums row or
 * no owner and is not shared, is visible to nobody.
 */
export function photoAccess(user: User, p: string): PhotoAccess {
  return {
    join: ` JOIN albums va ON va.name = ${p}.album`,
    where: ' AND (va.owner_email = ? OR EXISTS (SELECT 1 FROM json_each(va.shared_with) WHERE value = ?))',
    params: [user.email, user.email],
  };
}

/** canEdit for a photo read through photoAccess, from its album and the joined va.owner_email. */
export function canEditPhoto(user: User, album: string | null | undefined, albumOwner: string | null | undefined): boolean {
  return !!album && albumOwner != null && albumOwner === user.email;
}

/**
 * Returns a per-row "may this user edit the photo" check using one set-based query per request:
 * editable means the user owns the photo's album. owner_email = ? is an index search on
 * idx_albums_owner_email and reads only the user's own albums.
 */
export async function canEditFor(db: D1Database, user: User): Promise<(album: string | null | undefined) => boolean> {
  const rows = await db.prepare('SELECT name FROM albums WHERE owner_email = ?').bind(user.email).all<{ name: string }>();
  const owned = new Set(rows.results.map((r) => r.name));
  return (album) => !!album && owned.has(album);
}
