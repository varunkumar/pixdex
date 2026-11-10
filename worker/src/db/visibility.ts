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
  if (user.isDefaultOwner && !(await anyAlbumOwner(db))) return { sql: '', params: [] };
  return scopeFor(user, column);
}

/** Whether any album has an owner. One covering-index probe (idx_albums_owner_email), at most one row read. */
async function anyAlbumOwner(db: D1Database): Promise<boolean> {
  const r = await db.prepare('SELECT EXISTS(SELECT 1 FROM albums WHERE owner_email IS NOT NULL) AS x').first<{ x: number }>();
  return !!r?.x;
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
 * `va`, so `va.owner_email` is selectable. The default owner also sees photos with no album; nobody
 * else does. A photo whose album has no albums row is visible to nobody, as with scopeFor.
 */
export function photoAccess(user: User, p: string): PhotoAccess {
  const shared = 'EXISTS (SELECT 1 FROM json_each(va.shared_with) WHERE value = ?)';
  if (user.isDefaultOwner) {
    return {
      join: ` LEFT JOIN albums va ON va.name = ${p}.album`,
      where: ` AND (${p}.album IS NULL OR (va.name IS NOT NULL AND va.owner_email IS NULL) OR va.owner_email = ? OR ${shared})`,
      params: [user.email, user.email],
    };
  }
  return {
    join: ` JOIN albums va ON va.name = ${p}.album`,
    where: ` AND (va.owner_email = ? OR ${shared})`,
    params: [user.email, user.email],
  };
}

/** Like photoAccess, but null (no restriction, no join) for the default owner while no album has an owner. */
export async function photoAccessForRequest(db: D1Database, user: User, p: string): Promise<PhotoAccess | null> {
  if (user.isDefaultOwner && !(await anyAlbumOwner(db))) return null;
  return photoAccess(user, p);
}

/** canEdit for a photo read through photoAccess, from its album and the joined va.owner_email. */
export function canEditPhoto(user: User, album: string | null | undefined, albumOwner: string | null | undefined): boolean {
  if (!album) return user.isDefaultOwner;
  return albumOwner == null ? user.isDefaultOwner : albumOwner === user.email;
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
