import { embeddingFromBytes } from './embedding';
import { REFERENCES_PER_PERSON } from './matching';

export interface PersonReferences {
  personId: string;
  vectors: Float32Array[];
}

/**
 * For each person (or one, via `opts.personId`; or one owner's, via `opts.owner`, an index search on idx_persons_owner_name_lower), the REFERENCES_PER_PERSON
 * newest confirmed faces' vectors. "Newest" means newest by scan time
 * (faces.created_at), not by when the owner confirmed the face. People with no
 * confirmed faces are omitted.
 *
 * Rows read are bounded by people x REFERENCES_PER_PERSON: the per-person
 * subquery walks idx_faces_person_status_created (person_id, assign_status,
 * created_at) backwards and stops after the limit; CROSS JOIN pins persons as
 * the outer loop so faces are only fetched by rowid for the chosen ones.
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
  const stmt = db.prepare(
    `SELECT p.id AS person_id, f.embedding
     FROM persons p
     CROSS JOIN faces f ON f.rowid IN (
       SELECT f2.rowid FROM faces f2
       WHERE f2.person_id = p.id AND f2.assign_status = 'confirmed'
       ORDER BY f2.created_at DESC, f2.rowid DESC
       LIMIT ${REFERENCES_PER_PERSON}
     )
     ${where}
     ORDER BY p.id, f.created_at DESC, f.rowid DESC`
  );
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
