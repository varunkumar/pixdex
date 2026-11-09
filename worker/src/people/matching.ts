export const AUTO_THRESHOLD = 0.5;
export const SUGGEST_THRESHOLD = 0.4;
export const FACE_PAGE_SIZE = 100;
export const GROUPS_PAGE_SIZE = 50;
export const REFERENCES_PER_PERSON = 30;
/** Cap on multiply-adds (faces x total reference vectors x 512) one auto-match call may spend. */
export const MAX_AUTO_MATCH_MACS = 1_500_000;
export const MIN_DET_SCORE = 0.7;
export const MIN_FACE_SIDE = 0.05;

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

/**
 * Greedy clustering against one running centroid per cluster; largest clusters first.
 * A cluster keeps its raw sum and the sum's squared norm, updated incrementally on merge, so a face
 * is scored as dot(face, sum) / |sum| (the cosine against the unit centroid) with no per-merge
 * copy or 512-float renormalise.
 */
export function clusterFaces(faces: { id: string; embedding: Float32Array }[]): string[][] {
  const clusters: { ids: string[]; sum: Float32Array; norm: number; sumSq: number }[] = [];
  for (const f of faces) {
    let target = -1;
    let top = SUGGEST_THRESHOLD;
    for (let i = 0; i < clusters.length; i++) {
      const s = dot(f.embedding, clusters[i].sum) / clusters[i].norm;
      if (s >= top) {
        top = s;
        target = i;
      }
    }
    if (target === -1) {
      const sum = Float32Array.from(f.embedding);
      const sumSq = dot(sum, sum);
      clusters.push({ ids: [f.id], sum, sumSq, norm: Math.sqrt(sumSq) || 1 });
    } else {
      const c = clusters[target];
      c.ids.push(f.id);
      let cross = 0;
      let faceSq = 0;
      for (let k = 0; k < c.sum.length; k++) {
        const x = f.embedding[k] ?? 0;
        cross += c.sum[k] * x;
        faceSq += x * x;
        c.sum[k] += x;
      }
      c.sumSq = Math.max(0, c.sumSq + 2 * cross + faceSq);
      c.norm = Math.sqrt(c.sumSq) || 1;
    }
  }
  return clusters.map((c) => c.ids).sort((a, b) => b.length - a.length);
}
