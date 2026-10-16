import { embeddingFromBytes } from './embedding';
import { REFERENCES_PER_PERSON } from './matching';

export interface PersonReferences {
  personId: string;
  vectors: Float32Array[];
}

/**
 * For each person (or one, via `opts.personId`), the REFERENCES_PER_PERSON
 * newest confirmed faces' vectors. People with no confirmed faces are omitted.
 */
export async function loadReferences(db: D1Database, opts: { personId?: string } = {}): Promise<PersonReferences[]> {
  const where = opts.personId ? "AND person_id = ?" : '';
  const stmt = db.prepare(
    `SELECT person_id, embedding FROM (
       SELECT person_id, embedding,
         ROW_NUMBER() OVER (PARTITION BY person_id ORDER BY created_at DESC, rowid DESC) AS rn
       FROM faces
       WHERE assign_status = 'confirmed' AND person_id IS NOT NULL ${where}
     ) WHERE rn <= ${REFERENCES_PER_PERSON}
     ORDER BY person_id, rn`
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
