import { embeddingFromBytes, EMBEDDING_DIM } from './embedding';
import { MAX_AUTO_MATCH_MACS, bestScore, classify, isMatchable } from './matching';
import { loadReferences } from './references';

/**
 * Attaches each given `unassigned` face to the best-scoring named person when
 * the score clears the auto threshold and the pair was not rejected. Confirmed
 * and auto faces are never touched. Work is capped at MAX_AUTO_MATCH_MACS
 * multiply-adds per call (faces x total reference vectors x 512); matchable
 * faces beyond the budget are skipped (they stay unassigned) and counted.
 * At least one face is always scored so a large roster still makes progress.
 */
export async function autoMatchFaces(
  db: D1Database,
  faceIds: string[]
): Promise<{ matched: number; skipped: number }> {
  if (faceIds.length === 0) return { matched: 0, skipped: 0 };
  const ids = JSON.stringify(faceIds);

  const { results: faces } = await db
    .prepare(
      `SELECT id, embedding, det_score, bbox_w, bbox_h FROM faces
       WHERE id IN (SELECT value FROM json_each(?)) AND assign_status = 'unassigned'`
    )
    .bind(ids)
    .all<{ id: string; embedding: ArrayBuffer; det_score: number; bbox_w: number; bbox_h: number }>();
  const all = faces.filter((f) => isMatchable({ detScore: f.det_score, w: f.bbox_w, h: f.bbox_h }));
  if (all.length === 0) return { matched: 0, skipped: 0 };

  const refs = await loadReferences(db);
  if (refs.length === 0) return { matched: 0, skipped: 0 };

  const totalRefs = refs.reduce((n, r) => n + r.vectors.length, 0);
  const budgetFaces = Math.max(1, Math.floor(MAX_AUTO_MATCH_MACS / (totalRefs * EMBEDDING_DIM)));
  const candidates = all.slice(0, budgetFaces);
  const skipped = all.length - candidates.length;

  const { results: rejected } = await db
    .prepare('SELECT face_id, person_id FROM face_rejections WHERE face_id IN (SELECT value FROM json_each(?))')
    .bind(ids)
    .all<{ face_id: string; person_id: string }>();
  const rejectedPairs = new Set(rejected.map((r) => `${r.face_id}|${r.person_id}`));

  const updates: { id: string; personId: string; score: number }[] = [];
  for (const f of candidates) {
    const vec = embeddingFromBytes(f.embedding);
    let best: { personId: string; score: number } | undefined;
    for (const ref of refs) {
      if (rejectedPairs.has(`${f.id}|${ref.personId}`)) continue;
      const score = bestScore(vec, ref.vectors);
      if (!best || score > best.score) best = { personId: ref.personId, score };
    }
    if (best && classify(best.score) === 'auto') updates.push({ id: f.id, personId: best.personId, score: best.score });
  }
  if (updates.length > 0) {
    // One set-based statement (D1 limits queries per invocation).
    await db
      .prepare(
        `WITH x AS (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.personId') AS pid,
                           json_extract(value, '$.score') AS s FROM json_each(?))
         UPDATE faces SET assign_status = 'auto', person_id = x.pid, match_score = x.s
         FROM x WHERE faces.id = x.id AND faces.assign_status = 'unassigned'`
      )
      .bind(JSON.stringify(updates))
      .run();
  }
  return { matched: updates.length, skipped };
}
