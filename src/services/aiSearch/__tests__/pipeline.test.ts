import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../api/WorkerApiClient';
import { makePhoto } from '../../../test/fixtures';
import type { SerializedPhoto } from '../../../types/api';
import { CANDIDATE_LIMIT, PER_KEYWORD_LIMIT, RESULT_LIMIT, runAiSearch } from '../pipeline';

vi.mock('../../api/WorkerApiClient', () => ({
  workerApiClient: {
    searchPage: vi.fn(),
    thumbnailUrl: vi.fn((p: { thumbnailUrl?: string }) => `/api${p.thumbnailUrl}`),
  },
}));

const photo = (id: string, extra: Partial<SerializedPhoto> = {}) =>
  makePhoto({ id, thumbnailUrl: `/t/${id}`, ...extra });

type Handler = Record<string, { results: SerializedPhoto[]; total: number } | Error>;

function mockSearch(byTerm: Handler, libraryTotal = 1000) {
  vi.mocked(workerApiClient.searchPage).mockImplementation(async (params) => {
    const q = (params as { q?: string }).q;
    if (!q) return { results: [], total: libraryTotal };
    const r = byTerm[q];
    if (r instanceof Error) throw r;
    return r ?? { results: [], total: 0 };
  });
}

const noSpace = async () => ({ side: 'top' as const, score: 0 });

describe('runAiSearch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('searches each keyword and the library total', async () => {
    mockSearch({ eagle: { results: [photo('a')], total: 1 }, sky: { results: [photo('b')], total: 1 } });
    await runAiSearch(['eagle', 'sky'], { hidePeople: false, leaveRoom: false });
    expect(workerApiClient.searchPage).toHaveBeenCalledWith({ q: 'eagle', sort: 'rating', limit: PER_KEYWORD_LIMIT });
    expect(workerApiClient.searchPage).toHaveBeenCalledWith({ q: 'sky', sort: 'rating', limit: 100 });
    expect(workerApiClient.searchPage).toHaveBeenCalledWith({ limit: 1 });
    expect(workerApiClient.searchPage).toHaveBeenCalledTimes(3);
  });

  it('drops people photos when hidePeople and counts them', async () => {
    mockSearch({
      eagle: { results: [photo('a'), photo('b', { subjects: ['portrait'] })], total: 2 },
    });
    const res = await runAiSearch(['eagle'], { hidePeople: true, leaveRoom: false }, noSpace);
    expect(res.items.map((i) => i.photo.id)).toEqual(['a']);
    expect(res.hiddenPeople).toBe(1);
  });

  it('normalises keyword scores over the candidates that survive the people drop', async () => {
    mockSearch({
      eagle: { results: [photo('p', { subjects: ['portrait'], combinedScore: 5 })], total: 1 },
      sky: { results: [photo('p', { subjects: ['portrait'], combinedScore: 5 }), photo('a', { combinedScore: 5 })], total: 10 },
    });
    const hidden = await runAiSearch(['eagle', 'sky'], { hidePeople: true, leaveRoom: false }, noSpace);
    expect(hidden.items.map((i) => i.photo.id)).toEqual(['a']);
    expect(hidden.items[0].finalScore).toBeCloseTo(1 + (0.15 * 5) / 10);

    const shown = await runAiSearch(['eagle', 'sky'], { hidePeople: false, leaveRoom: false }, noSpace);
    expect(shown.items.map((i) => i.photo.id)).toEqual(['p', 'a']);
    expect(shown.items[0].finalScore).toBeCloseTo(1 + (0.15 * 5) / 10);
    expect(shown.items[1].finalScore).toBeLessThan(shown.items[0].finalScore - 0.1);
  });

  it('keeps people photos when hidePeople is false', async () => {
    mockSearch({
      eagle: { results: [photo('a'), photo('b', { subjects: ['portrait'] })], total: 2 },
    });
    const res = await runAiSearch(['eagle'], { hidePeople: false, leaveRoom: false }, noSpace);
    expect(res.items).toHaveLength(2);
    expect(res.hiddenPeople).toBe(0);
  });

  it('reports a failed keyword while the others still produce items', async () => {
    mockSearch({ eagle: new Error('boom'), sky: { results: [photo('b')], total: 1 } });
    const res = await runAiSearch(['eagle', 'sky'], { hidePeople: false, leaveRoom: false });
    expect(res.keywords).toEqual([
      { term: 'eagle', total: 0, failed: true },
      { term: 'sky', total: 1, failed: false },
    ]);
    expect(res.items.map((i) => i.photo.id)).toEqual(['b']);
  });

  it('rejects when every keyword search fails', async () => {
    mockSearch({ eagle: new Error('x'), sky: new Error('y') });
    await expect(runAiSearch(['eagle', 'sky'], { hidePeople: false, leaveRoom: false })).rejects.toThrow(Error);
  });

  it('returns no items for a zero total without throwing', async () => {
    mockSearch({ eagle: { results: [], total: 0 } });
    const res = await runAiSearch(['eagle'], { hidePeople: false, leaveRoom: true }, noSpace);
    expect(res.items).toEqual([]);
    expect(res.keywords).toEqual([{ term: 'eagle', total: 0, failed: false }]);
  });

  it('survives a failing library total search without NaN scores', async () => {
    vi.mocked(workerApiClient.searchPage).mockImplementation(async (params) => {
      if (!(params as { q?: string }).q) throw new Error('lib');
      return { results: [photo('a'), photo('b')], total: 2 };
    });
    const res = await runAiSearch(['eagle'], { hidePeople: false, leaveRoom: false });
    expect(res.items).toHaveLength(2);
    for (const i of res.items) expect(Number.isFinite(i.finalScore)).toBe(true);
  });

  it('ranks a photo with empty space above an equal one when leaveRoom', async () => {
    mockSearch({ eagle: { results: [photo('a'), photo('b')], total: 2 } });
    const measure = vi.fn(async (url: string) => ({ side: 'top' as const, score: url.endsWith('/b') ? 1 : 0 }));
    const res = await runAiSearch(['eagle'], { hidePeople: false, leaveRoom: true }, measure);
    expect(res.items.map((i) => i.photo.id)).toEqual(['b', 'a']);
    expect(res.items[0].textSpace?.score).toBe(1);
    expect(measure).toHaveBeenCalledWith('/api/t/a');
  });

  it('does not measure and leaves textSpace null when leaveRoom is false', async () => {
    mockSearch({ eagle: { results: [photo('a')], total: 1 } });
    const measure = vi.fn(noSpace);
    const res = await runAiSearch(['eagle'], { hidePeople: false, leaveRoom: false }, measure);
    expect(measure).not.toHaveBeenCalled();
    expect(res.items[0].textSpace).toBeNull();
  });

  it('keeps other photos when one measure resolves score 0', async () => {
    mockSearch({ eagle: { results: [photo('a'), photo('b'), photo('c')], total: 3 } });
    const measure = async (url: string) => ({ side: 'left' as const, score: url.endsWith('/a') ? 0 : 0.5 });
    const res = await runAiSearch(['eagle'], { hidePeople: false, leaveRoom: true }, measure);
    expect(res.items).toHaveLength(3);
    expect(res.items[2].photo.id).toBe('a');
  });

  it('measures at most the candidate limit and returns at most the result limit', async () => {
    const many = Array.from({ length: 200 }, (_, i) => photo(`p${i}`));
    mockSearch({ eagle: { results: many, total: 200 } });
    const measure = vi.fn(noSpace);
    const res = await runAiSearch(['eagle'], { hidePeople: false, leaveRoom: true }, measure);
    expect(measure).toHaveBeenCalledTimes(CANDIDATE_LIMIT);
    expect(res.items).toHaveLength(RESULT_LIMIT);
  });
});
