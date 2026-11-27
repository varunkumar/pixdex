import { embeddingFromBytes } from './embedding';

export interface PersonReferences {
  personId: string;
  vectors: Float32Array[];
}

export const referencesSql = (where: string) => `SELECT p.id AS person_id, f.embedding
  FROM persons p
  CROSS JOIN person_references r ON r.person_id = p.id
  CROSS JOIN faces f ON f.id = r.face_id AND +f.person_id = r.person_id AND +f.assign_status = 'confirmed'
  ${where}
  ORDER BY p.id, r.face_id`;

/**
 * The vectors of each person's stored reference faces (or one person's, via `opts.personId`; or one owner's, via
 * `opts.owner`, an index search on idx_persons_owner_name_lower). Which faces those are is decided when confirmed
 * faces change (referenceSelection.ts). A row whose face is no longer confirmed for the person is ignored. People
 * with no references are omitted.
 *
 * Rows read are bounded by people x REFERENCES_PER_PERSON: CROSS JOIN pins persons, then their rows by primary key,
 * then each face by id. The unary `+` keeps SQLite off the person index for the face.
 */
export async function loadReferences(db: D1Database, opts: { personId?: string; owner?: string } = {}): Promise<PersonReferences[]> {
  const conds: string[] = [];
  const binds: string[] = [];
  if (opts.personId) {
    conds.push('p.id = ?');
    binds.push(opts.personId);
  }
  if (opts.owner) {
    conds.push('p.owner_email = ?');
    binds.push(opts.owner);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const stmt = db.prepare(referencesSql(where));
  const { results } = await (binds.length ? stmt.bind(...binds) : stmt).all<{
    person_id: string;
    embedding: ArrayBuffer;
  }>();
  const byPerson = new Map<string, Float32Array[]>();
  for (const r of results) {
    const list = byPerson.get(r.person_id) ?? [];
    list.push(embeddingFromBytes(r.embedding));
    byPerson.set(r.person_id, list);
  }
  return [...byPerson].map(([personId, vectors]) => ({ personId, vectors }));
}

/** How long auto-match may reuse loaded references; bulk indexing tolerates this much staleness. */
export const REFERENCES_CACHE_TTL_MS = 60_000;

const cache = new Map<string, { at: number; refs: PersonReferences[] }>();

/**
 * loadReferences() for one owner's people, memoised per Worker isolate and per owner for
 * REFERENCES_CACHE_TTL_MS. Only for auto-match during ingest: a person confirmed or changed in the
 * last minute may be missed (or a just-unassigned face still used) by that one pass. Owner-driven
 * routes use loadReferences directly and are always fresh.
 */
export async function loadReferencesCached(db: D1Database, owner: string, now = Date.now()): Promise<PersonReferences[]> {
  const hit = cache.get(owner);
  if (hit && now - hit.at < REFERENCES_CACHE_TTL_MS) return hit.refs;
  const refs = await loadReferences(db, { owner });
  cache.set(owner, { at: now, refs });
  return refs;
}

export function clearReferencesCache(): void {
  cache.clear();
}
