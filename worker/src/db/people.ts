import type { User } from '../access';

export type PersonRole = 'owner' | 'viewer' | null;
export type FaceRole = 'owner' | 'viewer' | null;

/**
 * The user's role on a person: owner when persons.owner_email is theirs; viewer when someone else's
 * person has a confirmed or auto face in a photo the user can see; else null (404).
 * D1: 1 persons PK read, plus for a non-owner one bounded probe (idx_faces_person_id, then photo and album PK lookups).
 */
export async function personRole(db: D1Database, user: User, personId: string): Promise<PersonRole> {
  const p = await db.prepare('SELECT owner_email FROM persons WHERE id = ?').bind(personId).first<{ owner_email: string | null }>();
  if (!p) return null;
  if (p.owner_email !== null && p.owner_email === user.email) return 'owner';
  const seen = await db
    .prepare(
      `SELECT 1 AS x FROM faces f JOIN photos ph ON ph.id = f.photo_id JOIN albums va ON va.name = ph.album
       WHERE f.person_id = ? AND f.assign_status IN ('confirmed', 'auto')
         AND (va.owner_email = ? OR EXISTS (SELECT 1 FROM json_each(va.shared_with) WHERE value = ?)) LIMIT 1`
    )
    .bind(personId, user.email, user.email)
    .first();
  return seen ? 'viewer' : null;
}

/**
 * Role per face id through its photo's album (primary-key lookups only): owner of the album, viewer
 * (album shared with the user), or null (unknown face, no album, or not visible). One statement for all ids.
 */
export async function faceRoles(db: D1Database, user: User, ids: string[]): Promise<Map<string, FaceRole>> {
  const out = new Map<string, FaceRole>();
  if (ids.length === 0) return out;
  const { results } = await db
    .prepare(
      `SELECT j.value AS id, va.owner_email AS owner,
              EXISTS (SELECT 1 FROM json_each(va.shared_with) WHERE value = ?) AS shared
       FROM json_each(?) j
       LEFT JOIN faces f ON f.id = j.value
       LEFT JOIN photos ph ON ph.id = f.photo_id
       LEFT JOIN albums va ON va.name = ph.album`
    )
    .bind(user.email, JSON.stringify(ids))
    .all<{ id: string; owner: string | null; shared: number }>();
  for (const r of results) {
    out.set(r.id, r.owner !== null && r.owner === user.email ? 'owner' : r.shared ? 'viewer' : null);
  }
  return out;
}

/** The first failing status across roles: 404 when any is null, else 403 when any is not owner, else null. */
export function denial(roles: (FaceRole | PersonRole)[]): 404 | 403 | null {
  if (roles.some((r) => r === null)) return 404;
  if (roles.some((r) => r !== 'owner')) return 403;
  return null;
}
