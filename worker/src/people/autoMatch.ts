import { embeddingFromBytes } from './embedding';
import { bestScore, classify, isMatchable } from './matching';
import { loadReferences } from './references';

/**
 * Attaches each given `unassigned` face to the best-scoring named person when
 * the score clears the auto threshold and the pair was not rejected. Confirmed
 * and auto faces are never touched. Returns the number matched.
 */
export async function autoMatchFaces(db: D1Database, faceIds: string[]): Promise<number> {
  if (faceIds.length === 0) return 0;
  const ids = JSON.stringify(faceIds);

  const { results: faces } = await db
    .prepare(
      `SELECT id, embedding, det_score, bbox_w, bbox_h FROM faces
       WHERE id IN (SELECT value FROM json_each(?)) AND assign_status = 'unassigned'`
    )
    .bind(ids)
    .all<{ id: string; embedding: ArrayBuffer; det_score: number; bbox_w: number; bbox_h: number }>();
  const candidates = faces.filter((f) => isMatchable({ detScore: f.det_score, w: f.bbox_w, h: f.bbox_h }));
  if (candidates.length === 0) return 0;

  const refs = await loadReferences(db);
  if (refs.length === 0) return 0;

  const { results: rejected } = await db
    .prepare('SELECT face_id, person_id FROM face_rejections WHERE face_id IN (SELECT value FROM json_each(?))')
    .bind(ids)
    .all<{ face_id: string; person_id: string }>();
  const rejectedPairs = new Set(rejected.map((r) => `${r.face_id}|${r.person_id}`));

  const updates: D1PreparedStatement[] = [];
  for (const f of candidates) {
    const vec = embeddingFromBytes(f.embedding);
    let best: { personId: string; score: number } | undefined;
    for (const ref of refs) {
      if (rejectedPairs.has(`${f.id}|${ref.personId}`)) continue;
      const score = bestScore(vec, ref.vectors);
      if (!best || score > best.score) best = { personId: ref.personId, score };
    }
    if (best && classify(best.score) === 'auto') {
      updates.push(
        db
          .prepare(
            "UPDATE faces SET assign_status = 'auto', person_id = ?, match_score = ? WHERE id = ? AND assign_status = 'unassigned'"
          )
          .bind(best.personId, best.score, f.id)
      );
    }
  }
  if (updates.length > 0) await db.batch(updates);
  return updates.length;
}
