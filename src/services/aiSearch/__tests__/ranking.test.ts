import { describe, expect, it } from 'vitest';
import type { SerializedPhoto } from '../../../types/api';
import {
  WEIGHTS,
  finalScore,
  isPeoplePhoto,
  normalizeKeywords,
  photoRating,
  renormalize,
  scoreCandidates,
} from '../ranking';

function photo(id: string, over: Partial<SerializedPhoto> = {}): SerializedPhoto {
  return {
    id,
    path: null,
    driveFileId: null,
    dateTime: null,
    width: null,
    height: null,
    format: null,
    fileSize: null,
    subjects: [],
    colors: [],
    patterns: [],
    tags: [],
    season: null,
    environment: null,
    album: null,
    suggestedHashtags: [],
    instagramSuggested: null,
    ...over,
  } as SerializedPhoto;
}

describe('normalizeKeywords', () => {
  it('trims, lowercases, drops empties and dedupes in order', () => {
    expect(normalizeKeywords('Diwali, diya ,DIWALI,, ')).toEqual(['diwali', 'diya']);
  });
});

describe('isPeoplePhoto', () => {
  it('matches whole words in tags and subjects', () => {
    expect(isPeoplePhoto(photo('a', { tags: ['portrait'] }))).toBe(true);
    expect(isPeoplePhoto(photo('b', { subjects: ['Family dinner'] }))).toBe(true);
  });
  it('does not match substrings', () => {
    expect(isPeoplePhoto(photo('c', { subjects: ['manta ray'] }))).toBe(false);
    expect(isPeoplePhoto(photo('d', { subjects: ['leopard'] }))).toBe(false);
  });
});

describe('photoRating', () => {
  it('prefers combinedScore, then aestheticScore, then 0', () => {
    expect(photoRating(photo('a', { combinedScore: 7, aestheticScore: 3 }))).toBe(7);
    expect(photoRating(photo('b', { aestheticScore: 3 }))).toBe(3);
    expect(photoRating(photo('c'))).toBe(0);
  });
});

describe('scoreCandidates', () => {
  const a = photo('a');
  const b = photo('b');
  const c = photo('c');

  it('weights a rare term above a common one and rewards matching both', () => {
    const out = scoreCandidates(
      [
        { term: 'rare', total: 5, photos: [a] },
        { term: 'common', total: 3000, photos: [a, b] },
      ],
      4000,
    );
    expect(out.map((x) => x.photo.id)).toEqual(['a', 'b']);
    expect(out[0].hits).toEqual(['rare', 'common']);
    expect(out[1].hits).toEqual(['common']);
    expect(out[0].keywordScore).toBeGreaterThan(out[1].keywordScore);
    expect(out[0].keywordNorm).toBe(1);
    expect(out[1].keywordNorm).toBeLessThan(1);
  });

  it('skips results with total 0', () => {
    const out = scoreCandidates(
      [
        { term: 'none', total: 0, photos: [c] },
        { term: 'some', total: 10, photos: [a] },
      ],
      100,
    );
    expect(out.map((x) => x.photo.id)).toEqual(['a']);
    expect(out[0].hits).toEqual(['some']);
  });

  it('gives zero scores, not NaN, when every term matches the whole library', () => {
    const out = scoreCandidates([{ term: 'all', total: 100, photos: [a, b] }], 100);
    expect(out).toHaveLength(2);
    for (const cand of out) {
      expect(cand.keywordScore).toBe(0);
      expect(cand.keywordNorm).toBe(0);
    }
  });
});

describe('finalScore', () => {
  const cand = {
    photo: photo('a', { combinedScore: 8 }),
    hits: ['x'],
    keywordScore: 2,
    keywordNorm: 0.5,
  };
  it('combines keyword, space and rating when leaving room', () => {
    expect(finalScore(cand, 0.4, true)).toBeCloseTo(0.5 + 0.6 * 0.4 + (0.15 * 8) / 10);
  });
  it('omits the space term otherwise', () => {
    expect(finalScore(cand, 0.4, false)).toBeCloseTo(0.5 + (0.15 * 8) / 10);
  });
  it('exposes the weights', () => {
    expect(WEIGHTS).toEqual({ keyword: 1, space: 0.6, rating: 0.15 });
  });
});

describe('renormalize', () => {
  const cand = (id: string, keywordScore: number, keywordNorm: number) => ({
    photo: photo(id),
    hits: ['x'],
    keywordScore,
    keywordNorm,
  });

  it('rescales to the best kept candidate without mutating the input', () => {
    const input = [cand('a', 2, 0.5), cand('b', 1, 0.25)];
    const out = renormalize(input);
    expect(out.map((c) => c.keywordNorm)).toEqual([1, 0.5]);
    expect(input.map((c) => c.keywordNorm)).toEqual([0.5, 0.25]);
  });

  it('gives norm 0 when the maximum score is 0 and handles an empty list', () => {
    expect(renormalize([cand('a', 0, 0.3)])[0].keywordNorm).toBe(0);
    expect(renormalize([])).toEqual([]);
  });
});
