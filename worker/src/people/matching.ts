export const AUTO_THRESHOLD = 0.5;
export const SUGGEST_THRESHOLD = 0.4;
export const FACE_PAGE_SIZE = 300;
export const GROUPS_PAGE_SIZE = 150;
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

/** Greedy clustering against one running L2-normalised centroid per cluster; largest clusters first. */
export function clusterFaces(faces: { id: string; embedding: Float32Array }[]): string[][] {
  const clusters: { ids: string[]; sum: Float32Array; centroid: Float32Array }[] = [];
  for (const f of faces) {
    let target = -1;
    let top = SUGGEST_THRESHOLD;
    for (let i = 0; i < clusters.length; i++) {
      const s = dot(f.embedding, clusters[i].centroid);
      if (s >= top) {
        top = s;
        target = i;
      }
    }
    if (target === -1) {
      const sum = Float32Array.from(f.embedding);
      clusters.push({ ids: [f.id], sum, centroid: unitCopy(sum) });
    } else {
      const c = clusters[target];
      c.ids.push(f.id);
      for (let k = 0; k < c.sum.length; k++) c.sum[k] += f.embedding[k] ?? 0;
      c.centroid = unitCopy(c.sum);
    }
  }
  return clusters.map((c) => c.ids).sort((a, b) => b.length - a.length);
}

function unitCopy(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}
