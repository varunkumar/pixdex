export const AUTO_THRESHOLD = 0.5;
export const SUGGEST_THRESHOLD = 0.4;
export const FACE_PAGE_SIZE = 1000;
export const REFERENCES_PER_PERSON = 30;
export const MIN_DET_SCORE = 0.6;
export const MIN_FACE_SIDE = 0.03;

/** SQL condition over `faces` columns, mirroring isMatchable. */
export const MATCHABLE_SQL = `det_score >= ${MIN_DET_SCORE} AND bbox_w >= ${MIN_FACE_SIDE} AND bbox_h >= ${MIN_FACE_SIDE}`;

export function isMatchable(face: { detScore: number; w: number; h: number }): boolean {
  return face.detScore >= MIN_DET_SCORE && face.w >= MIN_FACE_SIDE && face.h >= MIN_FACE_SIDE;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export function bestScore(face: Float32Array, refs: Float32Array[]): number {
  let best = -1;
  for (const r of refs) {
    const d = dot(face, r);
    if (d > best) best = d;
  }
  return best;
}

export function classify(score: number): 'auto' | 'suggest' | 'none' {
  if (score >= AUTO_THRESHOLD) return 'auto';
  if (score >= SUGGEST_THRESHOLD) return 'suggest';
  return 'none';
}

/** Greedy clustering by best link; largest clusters first. */
export function clusterFaces(faces: { id: string; embedding: Float32Array }[]): string[][] {
  const clusters: { ids: string[]; embs: Float32Array[] }[] = [];
  for (const f of faces) {
    let target = -1;
    let top = SUGGEST_THRESHOLD;
    for (let i = 0; i < clusters.length; i++) {
      const s = bestScore(f.embedding, clusters[i].embs);
      if (s >= top) {
        top = s;
        target = i;
      }
    }
    if (target === -1) clusters.push({ ids: [f.id], embs: [f.embedding] });
    else {
      clusters[target].ids.push(f.id);
      clusters[target].embs.push(f.embedding);
    }
  }
  return clusters.map((c) => c.ids).sort((a, b) => b.length - a.length);
}
