import type { SerializedPhoto } from '../../types/api';
import { workerApiClient } from '../api/WorkerApiClient';
import { finalScore, isPeoplePhoto, photoRating, scoreCandidates, type KeywordResult } from './ranking';
import { measureTextSpace, type TextSpace } from './textSpace';

export const CANDIDATE_LIMIT = 150;
export const RESULT_LIMIT = 48;
export const PER_KEYWORD_LIMIT = 100;

export interface AiSearchOptions {
  hidePeople: boolean;
  leaveRoom: boolean;
}

export interface RankedPhoto {
  photo: SerializedPhoto;
  hits: string[];
  textSpace: TextSpace | null;
  rating: number;
  finalScore: number;
}

export interface KeywordReport {
  term: string;
  total: number;
  failed: boolean;
}

export interface AiSearchResult {
  items: RankedPhoto[];
  keywords: KeywordReport[];
  hiddenPeople: number;
}

const finite = (n: number) => (Number.isFinite(n) ? n : 0);

export async function runAiSearch(
  terms: string[],
  options: AiSearchOptions,
  measure: (url: string) => Promise<TextSpace> = measureTextSpace
): Promise<AiSearchResult> {
  const [settled, library] = await Promise.all([
    Promise.allSettled(
      terms.map((term) => workerApiClient.searchPage({ q: term, sort: 'rating', limit: PER_KEYWORD_LIMIT }))
    ),
    workerApiClient.searchPage({ limit: 1 }).then(
      (r) => r.total,
      () => 0
    ),
  ]);

  const keywords: KeywordReport[] = [];
  const results: KeywordResult[] = [];
  settled.forEach((s, i) => {
    const term = terms[i];
    if (s.status === 'fulfilled') {
      keywords.push({ term, total: s.value.total, failed: false });
      results.push({ term, total: s.value.total, photos: s.value.results });
    } else {
      keywords.push({ term, total: 0, failed: true });
    }
  });
  if (terms.length > 0 && keywords.every((k) => k.failed)) {
    throw new Error('Every keyword search failed');
  }

  // If the library total is unavailable, fall back to the largest keyword total
  // so rarity weights stay finite (they just become less discriminating).
  const libraryTotal = library > 0 ? library : Math.max(0, ...results.map((r) => r.total));
  let candidates = scoreCandidates(results, libraryTotal);

  let hiddenPeople = 0;
  if (options.hidePeople) {
    const kept = candidates.filter((c) => !isPeoplePhoto(c.photo));
    hiddenPeople = candidates.length - kept.length;
    candidates = kept;
  }
  candidates = candidates.slice(0, CANDIDATE_LIMIT);

  const spaces: (TextSpace | null)[] = options.leaveRoom
    ? await Promise.all(candidates.map((c) => measure(workerApiClient.thumbnailUrl(c.photo))))
    : candidates.map(() => null);

  const items: RankedPhoto[] = candidates.map((c, i) => ({
    photo: c.photo,
    hits: c.hits,
    textSpace: spaces[i],
    rating: finite(photoRating(c.photo)),
    finalScore: finite(finalScore(c, finite(spaces[i]?.score ?? 0), options.leaveRoom)),
  }));
  items.sort((a, b) => b.finalScore - a.finalScore);

  return { items: items.slice(0, RESULT_LIMIT), keywords, hiddenPeople };
}
