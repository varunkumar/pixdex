import { embeddingFromBytes } from './embedding';
import { REFERENCES_PER_PERSON } from './matching';

export interface PersonReferences {
  personId: string;
  vectors: Float32Array[];
}

/**
 * For each person (or one, via `opts.personId`), the REFERENCES_PER_PERSON
 * newest confirmed faces' vectors. "Newest" means newest by scan time
 * (faces.created_at), not by when the owner confirmed the face. People with no
 * confirmed faces are omitted.
 *
 * Rows read are bounded by people x REFERENCES_PER_PERSON: the per-person
 * subquery walks idx_faces_person_status_created (person_id, assign_status,
 * created_at) backwards and stops after the limit; CROSS JOIN pins persons as
 * the outer loop so faces are only fetched by rowid for the chosen ones.
 */
export async function loadReferences(db: D1Database, opts: { personId?: string } = {}): Promise<PersonReferences[]> {
  const where = opts.personId ? 'WHERE p.id = ?' : '';
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
  const { results } = await (opts.personId ? stmt.bind(opts.personId) : stmt).all<{
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
