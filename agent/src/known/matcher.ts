import type { Gallery } from './gallery';

/** Initial values, to be tuned by the dry run. */
export const KNOWN_THRESHOLD = 0.5;
export const KNOWN_MARGIN = 0.05;

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Matches a normalised face embedding against the gallery. A person's score is the best cosine over its
 * refs. The top person is accepted only if its score is at least KNOWN_THRESHOLD and beats the best
 * score of every other person by at least KNOWN_MARGIN.
 */
export function matchKnown(embedding: Float32Array, gallery: Gallery): { id: string; score: number } | null {
  let best: { id: string; score: number } | undefined;
  let second = -Infinity;
  for (const person of gallery.people) {
    let score = -Infinity;
    for (const ref of person.refs) score = Math.max(score, dot(embedding, ref));
    if (score === -Infinity) continue;
    if (!best || score > best.score) {
      if (best) second = Math.max(second, best.score);
      best = { id: person.id, score };
    } else {
      second = Math.max(second, score);
    }
  }
  if (!best || best.score < KNOWN_THRESHOLD) return null;
  // Small epsilon: float32 rounding must not flip an exact-margin case.
  if (best.score - second < KNOWN_MARGIN - 1e-9) return null;
  // Two float32 vectors can give a cosine a hair above 1; the Worker rejects a score above 1.
  return { id: best.id, score: Math.min(1, Math.max(0, best.score)) };
}
