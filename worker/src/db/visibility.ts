import type { User } from '../access';

export interface Scope {
  sql: string;
  params: unknown[];
}

/** Subquery of album names the user may see: owned (NULL owner = default owner) or shared with them. */
export function visibleAlbumsSql(user: User): Scope {
  const owner = user.isDefaultOwner ? '(owner_email IS NULL OR owner_email = ?)' : 'owner_email = ?';
  return {
    sql: `(SELECT name FROM albums WHERE ${owner} OR EXISTS (SELECT 1 FROM json_each(albums.shared_with) WHERE value = ?))`,
    params: [user.email, user.email],
  };
}

/** AND-clause limiting `column` (a photos album column) to the user's visible albums. */
export function scopeFor(user: User, column: string): Scope {
  const v = visibleAlbumsSql(user);
  const nullOk = user.isDefaultOwner ? `${column} IS NULL OR ` : '';
  return { sql: ` AND (${nullOk}${column} IN ${v.sql})`, params: v.params };
}

/**
 * Like scopeFor, but empty for the default owner while no album has an owner (the single-user
 * state), so that user keeps unscoped queries and the counters total.
 */
export async function scopeForRequest(db: D1Database, user: User, column: string): Promise<Scope> {
  if (user.isDefaultOwner) {
    const r = await db.prepare('SELECT EXISTS(SELECT 1 FROM albums WHERE owner_email IS NOT NULL) AS x').first<{ x: number }>();
    if (!r?.x) return { sql: '', params: [] };
  }
  return scopeFor(user, column);
}

/**
 * Returns a per-row "may this user edit the photo" check using at most one set-based query per request.
 * Editable means the user owns the photo's album, or the photo has no album and the user is the default owner.
 * With an empty scope (default owner, no album has an owner) everything is editable and no query runs.
 */
export async function canEditFor(db: D1Database, user: User, scope: Scope): Promise<(album: string | null | undefined) => boolean> {
  if (user.isDefaultOwner && scope.sql === '') return () => true;
  const owner = user.isDefaultOwner ? '(owner_email IS NULL OR owner_email = ?)' : 'owner_email = ?';
  const rows = await db.prepare(`SELECT name FROM albums WHERE ${owner}`).bind(user.email).all<{ name: string }>();
  const owned = new Set(rows.results.map((r) => r.name));
  return (album) => (album ? owned.has(album) : user.isDefaultOwner);
}
