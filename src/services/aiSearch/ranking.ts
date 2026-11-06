import type { SerializedPhoto } from '../../types/api';

export const WEIGHTS = { keyword: 1, space: 0.6, rating: 0.15 } as const;

const PEOPLE_WORDS = [
  'person', 'people', 'man', 'men', 'woman', 'women', 'boy', 'girl', 'child',
  'children', 'kid', 'kids', 'baby', 'portrait', 'couple', 'group', 'human',
  'family', 'crowd', 'tourist', 'face', 'rider', 'driver', 'selfie', 'bride',
  'groom',
];
const PEOPLE_RE = new RegExp(`\\b(?:${PEOPLE_WORDS.join('|')})\\b`, 'i');

/** Split a comma list into trimmed, lowercased, deduplicated terms (order kept). */
export function normalizeKeywords(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const term = part.trim().toLowerCase();
    if (term && !out.includes(term)) out.push(term);
  }
  return out;
}

export function isPeoplePhoto(photo: SerializedPhoto): boolean {
  return [...photo.subjects, ...photo.tags].some((s) => PEOPLE_RE.test(s));
}

export interface KeywordResult {
  term: string;
  total: number;
  photos: SerializedPhoto[];
}

export interface Candidate {
  photo: SerializedPhoto;
  hits: string[];
  keywordScore: number;
  keywordNorm: number;
}

/**
 * Score photos by the keywords they matched, weighting each term by its rarity
 * (log of library size over match count) so rare terms count for more.
 */
export function scoreCandidates(results: KeywordResult[], libraryTotal: number): Candidate[] {
  const byId = new Map<string, Candidate>();
  for (const r of results) {
    if (r.total <= 0) continue;
    const idf = Math.max(0, Math.log(libraryTotal / r.total));
    for (const photo of r.photos) {
      let c = byId.get(photo.id);
      if (!c) {
        c = { photo, hits: [], keywordScore: 0, keywordNorm: 0 };
        byId.set(photo.id, c);
      }
      if (!c.hits.includes(r.term)) {
        c.hits.push(r.term);
        c.keywordScore += idf;
      }
    }
  }
  const list = [...byId.values()].sort((a, b) => b.keywordScore - a.keywordScore);
  const max = list.length ? list[0].keywordScore : 0;
  for (const c of list) c.keywordNorm = max > 0 ? c.keywordScore / max : 0;
  return list;
}

export function photoRating(photo: SerializedPhoto): number {
  return photo.combinedScore ?? photo.aestheticScore ?? 0;
}

export function finalScore(c: Candidate, textSpace: number, leaveRoom: boolean): number {
  return (
    WEIGHTS.keyword * c.keywordNorm +
    (leaveRoom ? WEIGHTS.space * textSpace : 0) +
    (WEIGHTS.rating * photoRating(c.photo)) / 10
  );
}
