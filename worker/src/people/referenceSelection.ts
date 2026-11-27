import { REFERENCES_PER_PERSON } from './matching';

/**
 * Which confirmed faces are a person's matching references, stored in person_references.
 *
 * The rule: bucket the person's confirmed faces by the photo's year (no date is a bucket of its own), rank each
 * bucket by face box area, then detection score, then rowid, and take every bucket's best, then every bucket's
 * second, and so on, up to REFERENCES_PER_PERSON. So every year the person was photographed in is covered.
 * Migration 0023 fills the table with the same rule: change both together (a test compares them).
 */

/**
 * The people to recompute: ?1, a JSON array of person ids, plus whoever holds one of ?2, a JSON array of face ids,
 * as a reference. Removing a face that is not a reference cannot change a selection, so nobody else is affected.
 */
const AFFECTED = `SELECT value AS id FROM json_each(?1)
  UNION SELECT person_id FROM person_references WHERE face_id IN (SELECT value FROM json_each(?2))`;

/** The affected people's references as they should be (binds as AFFECTED). Walks only their confirmed faces. */
export const CHOOSE_REFERENCES_SQL = `SELECT person_id, face_id FROM (
  SELECT person_id, face_id, ROW_NUMBER() OVER (PARTITION BY person_id ORDER BY turn, year, rid) AS pick FROM (
    SELECT f.person_id, f.id AS face_id, f.rowid AS rid, COALESCE(substr(ph.date_time, 1, 4), '') AS year,
      ROW_NUMBER() OVER (
        PARTITION BY f.person_id, COALESCE(substr(ph.date_time, 1, 4), '')
        ORDER BY f.bbox_w * f.bbox_h DESC, f.det_score DESC, f.rowid
      ) AS turn
    FROM (${AFFECTED}) s
    CROSS JOIN faces f INDEXED BY idx_faces_person_status_created ON f.person_id = s.id AND f.assign_status = 'confirmed'
    LEFT JOIN photos ph ON ph.id = f.photo_id
  )
) WHERE pick <= ${REFERENCES_PER_PERSON}`;

/** Binds ?1: the chosen rows as a JSON array of [person id, face id]. */
export const ADD_REFERENCES_SQL = `INSERT OR IGNORE INTO person_references (person_id, face_id)
  SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?1)`;

/** Binds ?1, ?2 as AFFECTED and ?3 the chosen rows. */
export const DROP_REFERENCES_SQL = `DELETE FROM person_references
  WHERE person_id IN (SELECT id FROM (${AFFECTED}))
    AND (person_id, face_id) NOT IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?3))`;

/**
 * Brings references up to date after a write that changed confirmed faces; call it once that write is committed.
 * `faceIds` are faces that may have left a person (their old rows still say who held them). Only changed rows are
 * written; returns how many. It never throws: the write it follows is already saved, a stale row is ignored by
 * loadReferences, and the next change or "Re-run matching" repairs the choice.
 * D1: the choice is read once (about 6 rows per confirmed face of the affected people, a few rows when nobody is
 * affected), then 2 statements over at most REFERENCES_PER_PERSON rows each person.
 */
export async function refreshReferences(
  db: D1Database,
  { personIds = [], faceIds = [] }: { personIds?: string[]; faceIds?: string[] }
): Promise<number> {
  const binds = [JSON.stringify(personIds), JSON.stringify(faceIds)];
  try {
    const { results } = await db.prepare(CHOOSE_REFERENCES_SQL).bind(...binds).all<{ person_id: string; face_id: string }>();
    const chosen = JSON.stringify(results.map((r) => [r.person_id, r.face_id]));
    const written = await db.batch([
      db.prepare(ADD_REFERENCES_SQL).bind(chosen),
      db.prepare(DROP_REFERENCES_SQL).bind(...binds, chosen),
    ]);
    return written.reduce((n, r) => n + r.meta.rows_written, 0);
  } catch (err) {
    console.error('Could not refresh matching references', err);
    return 0;
  }
}
