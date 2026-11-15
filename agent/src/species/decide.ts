import type { SpeciesEntry } from '../cloudflareClient';

/** [common name, scientific name, class, score 0..1] */
export type SpeciesCandidate = [string, string, string, number];

export interface SpeciesBox {
  /** [x0, y0, x1, y1] as fractions of the image. */
  box: [number, number, number, number];
  det: number;
  kind: 'bird' | 'animal';
  preds: SpeciesCandidate[];
}

/** What the species sidecar returns for one photo: the whole-frame top answers and the detector boxes' answers. */
export interface SpeciesDetection {
  model: string;
  whole: SpeciesCandidate[];
  boxes: SpeciesBox[];
}

/**
 * Thresholds from the evaluation on a labelled library (scores below about 0.5 were guesses):
 * a weaker answer becomes "no species" rather than a wrong one.
 */
export const WHOLE_MIN = 0.5;
export const BIRD_MIN = 0.5;
export const MAX_SPECIES = 6;

/**
 * Chooses the species to store for one photo.
 * - Mammals and other animals come from the whole frame only: a crop of part of a big animal misreads it
 *   (a gaur's head became a water buffalo), and detectors miss animals that fill the frame.
 * - Birds come from the bird boxes (far more accurate on small birds, and the way a second bird, or a
 *   myna sitting on a deer, is found). When any bird box is confident it replaces a whole-frame bird answer;
 *   otherwise a confident whole-frame bird stays.
 * A species is listed once with its best score; best first.
 */
export function decideSpecies(
  detection: SpeciesDetection,
  options: { wholeMin?: number; birdMin?: number; max?: number } = {}
): SpeciesEntry[] {
  const { wholeMin = WHOLE_MIN, birdMin = BIRD_MIN, max = MAX_SPECIES } = options;

  const birds: SpeciesEntry[] = [];
  for (const b of detection.boxes) {
    if (b.kind !== 'bird') continue;
    const top = b.preds[0];
    if (top && top[3] >= birdMin) birds.push({ common: top[0], scientific: top[1], score: top[3], box: b.box });
  }

  const found: SpeciesEntry[] = [...birds];
  const whole = detection.whole[0];
  if (whole && whole[3] >= wholeMin && !(whole[2] === 'Aves' && birds.length > 0)) {
    found.push({ common: whole[0], scientific: whole[1], score: whole[3] });
  }

  const best = new Map<string, SpeciesEntry>();
  for (const s of found) {
    const have = best.get(s.scientific);
    if (!have || s.score > have.score) best.set(s.scientific, s);
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((s) => ({ ...s, score: Math.round(s.score * 1000) / 1000 }));
}
