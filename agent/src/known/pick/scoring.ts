import { dot, medianReference } from '../buildGallery';
import type { PersonCandidates } from './candidates';

export const WARN_COSINE = 0.3;

export interface FaceRef {
  photo: number;
  face: number;
}

const emb = (c: PersonCandidates, r: FaceRef) => c.photos[r.photo].faces[r.face].embedding;

/** Single-face photos are the preselected picks (every candidate photo kept has at least one usable face). */
export function preselected(c: PersonCandidates): FaceRef[] {
  const out: FaceRef[] = [];
  c.photos.forEach((p, photo) => {
    if (p.faces.length === 1) out.push({ photo, face: 0 });
  });
  return out;
}

/**
 * For each group photo (2+ faces), the face with the highest max cosine against the current picks (same math as
 * buildGallery's pickGroupFace, without its threshold or margin: it is only a highlight). Faces already picked are
 * skipped. Empty when there are no picks.
 */
export function suggest(c: PersonCandidates, picks: FaceRef[]): (FaceRef & { cosine: number })[] {
  if (picks.length === 0) return [];
  const anchors = picks.map((r) => emb(c, r));
  const taken = new Set(picks.map((r) => `${r.photo}:${r.face}`));
  const out: (FaceRef & { cosine: number })[] = [];
  c.photos.forEach((p, photo) => {
    if (p.faces.length < 2) return;
    let best = -Infinity;
    let bestFace = -1;
    p.faces.forEach((f, face) => {
      if (taken.has(`${photo}:${face}`)) return;
      let cos = -Infinity;
      for (const a of anchors) cos = Math.max(cos, dot(f.embedding, a));
      if (cos > best) {
        best = cos;
        bestFace = face;
      }
    });
    if (bestFace >= 0) out.push({ photo, face: bestFace, cosine: best });
  });
  return out;
}

/** Picks whose cosine against the median of the OTHER picks is below WARN_COSINE (needs at least 2 other picks). */
export function lowCosinePicks(c: PersonCandidates, picks: FaceRef[]): (FaceRef & { cosine: number })[] {
  const out: (FaceRef & { cosine: number })[] = [];
  if (picks.length < 3) return out;
  for (const [i, r] of picks.entries()) {
    const others = picks.filter((_, j) => j !== i).map((o) => emb(c, o));
    const cosine = dot(emb(c, r), medianReference(others));
    if (cosine < WARN_COSINE) out.push({ ...r, cosine });
  }
  return out;
}
