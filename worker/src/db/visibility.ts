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
