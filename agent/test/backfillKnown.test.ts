import { describe, expect, it, vi } from 'vitest';
import { backfillKnown } from '../src/backfillKnown';
import type { Gallery } from '../src/known/gallery';

function unit(i: number): Float32Array {
  const v = new Float32Array(512);
  v[i] = 1;
  return v;
}

const gallery: Gallery = {
  model: 'm1',
  people: [
    { id: 'Q1', name: 'Alice', aliases: [], refs: [unit(0)] },
    { id: 'Q2', name: 'Bob', aliases: [], refs: [unit(1)] },
  ],
};

type Page = { faces: { id: string; embedding: Float32Array }[]; nextCursor?: number };

function setup(pages: Page[], opts: { setFaceKnown?: ReturnType<typeof vi.fn> } = {}) {
  const faceEmbeddingsPage = vi.fn();
  for (const p of pages) faceEmbeddingsPage.mockResolvedValueOnce(p);
  const setFaceKnown = opts.setFaceKnown ?? vi.fn(async (m: unknown[]) => m.length);
  return { cloudflareClient: { faceEmbeddingsPage, setFaceKnown } as never, faceEmbeddingsPage, setFaceKnown };
}

const face = (id: string, i: number) => ({ id, embedding: unit(i) });
const mk = (n: number, start: number) => Array.from({ length: n }, (_, k) => face(`f${start + k}`, 0));

describe('backfillKnown', () => {
  it('dry run writes nothing and returns counts, histogram and samples', async () => {
    const s = setup([{ faces: [face('f1', 0), face('f2', 1), face('f3', 5)] }]);
    const r = await backfillKnown({ cloudflareClient: s.cloudflareClient, gallery, model: 'm1', dryRun: true });
    expect(s.setFaceKnown).not.toHaveBeenCalled();
    expect(r.scanned).toBe(3);
    expect(r.matched).toBe(2);
    expect(r.written).toBe(0);
    expect(r.perPerson).toEqual([
      { id: 'Q1', name: 'Alice', count: 1 },
      { id: 'Q2', name: 'Bob', count: 1 },
    ]);
    expect(r.scoreBuckets['1.00']).toBe(2);
    expect(r.samples.map((x) => x.faceId)).toEqual(['f1', 'f2']);
  });

  it('writes only matched faces in batches of at most 200 and follows nextCursor, including empty pages', async () => {
    const s = setup([
      { faces: mk(100, 0), nextCursor: 10 },
      { faces: [], nextCursor: 20 },
      { faces: [...mk(100, 100), face('none', 9)], nextCursor: 30 },
      { faces: mk(50, 300) },
    ]);
    const r = await backfillKnown({ cloudflareClient: s.cloudflareClient, gallery, model: 'm1' });
    expect(s.faceEmbeddingsPage.mock.calls.map((c) => c[1])).toEqual([
      { cursor: undefined, rescore: false },
      { cursor: 10, rescore: false },
      { cursor: 20, rescore: false },
      { cursor: 30, rescore: false },
    ]);
    const sizes = s.setFaceKnown.mock.calls.map((c) => c[0].length);
    expect(sizes.every((n) => n <= 200)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(250);
    expect(
      s.setFaceKnown.mock.calls.flatMap((c) => c[0]).some((m: { faceId: string }) => m.faceId === 'none')
    ).toBe(false);
    expect(r.written).toBe(250);
    expect(r.matched).toBe(250);
  });

  it('passes pageSize to every page as limit', async () => {
    const s = setup([{ faces: [], nextCursor: 5 }, { faces: [] }]);
    await backfillKnown({ cloudflareClient: s.cloudflareClient, gallery, model: 'm1', pageSize: 25 });
    expect(s.faceEmbeddingsPage.mock.calls.map((c) => c[1])).toEqual([
      { cursor: undefined, rescore: false, limit: 25 },
      { cursor: 5, rescore: false, limit: 25 },
    ]);
  });

  it('rescore passes rescore and clears faces that no longer match', async () => {
    const s = setup([{ faces: [face('f1', 0), face('f2', 7)] }]);
    const r = await backfillKnown({ cloudflareClient: s.cloudflareClient, gallery, model: 'm1', rescore: true });
    expect(s.faceEmbeddingsPage).toHaveBeenCalledWith('m1', { cursor: undefined, rescore: true });
    const sent = s.setFaceKnown.mock.calls.flatMap((c) => c[0]);
    expect(sent).toEqual([
      { faceId: 'f1', knownId: 'Q1', score: expect.any(Number) },
      { faceId: 'f2', knownId: null },
    ]);
    expect(r.matched).toBe(1);
    expect(r.cleared).toBe(1);
  });

  it('throws on a model mismatch before any request', async () => {
    const s = setup([]);
    await expect(backfillKnown({ cloudflareClient: s.cloudflareClient, gallery, model: 'other' })).rejects.toThrow(
      /other.*m1|m1.*other/
    );
    expect(s.faceEmbeddingsPage).not.toHaveBeenCalled();
  });

  it('skips undecodable embeddings without aborting', async () => {
    const bad = new Float32Array(512);
    bad[0] = NaN;
    const s = setup([
      { faces: [{ id: 'bad', embedding: bad }, { id: 'zero', embedding: new Float32Array(512) }, face('ok', 0)] },
    ]);
    const r = await backfillKnown({ cloudflareClient: s.cloudflareClient, gallery, model: 'm1', dryRun: true });
    expect(r.scanned).toBe(3);
    expect(r.skipped).toBe(2);
    expect(r.matched).toBe(1);
  });

  it('stops on a Worker error and leaves earlier batches written', async () => {
    const setFaceKnown = vi
      .fn()
      .mockResolvedValueOnce(200)
      .mockRejectedValueOnce(new Error('ingest/faces/known failed: 500'));
    const s = setup(
      [
        { faces: mk(100, 0), nextCursor: 1 },
        { faces: mk(100, 100), nextCursor: 2 },
        { faces: mk(100, 200), nextCursor: 3 },
        { faces: mk(100, 300) },
      ],
      { setFaceKnown }
    );
    await expect(backfillKnown({ cloudflareClient: s.cloudflareClient, gallery, model: 'm1' })).rejects.toThrow(/500/);
    expect(setFaceKnown).toHaveBeenCalledTimes(2);
    expect(s.faceEmbeddingsPage).toHaveBeenCalledTimes(4);
  });

  it('suggests build-known-gallery on a 400 from the write route', async () => {
    const setFaceKnown = vi.fn().mockRejectedValue(new Error('ingest/faces/known failed: 400'));
    const s = setup([{ faces: [face('f1', 0)] }], { setFaceKnown });
    await expect(backfillKnown({ cloudflareClient: s.cloudflareClient, gallery, model: 'm1' })).rejects.toThrow(
      /build-known-gallery/
    );
  });

  it('aborts when the cursor does not strictly advance or is not a number', async () => {
    const same = setup([
      { faces: [], nextCursor: 5 },
      { faces: [], nextCursor: 5 },
    ]);
    await expect(backfillKnown({ cloudflareClient: same.cloudflareClient, gallery, model: 'm1' })).rejects.toThrow(
      /cursor/i
    );
    const nan = setup([{ faces: [], nextCursor: Number.NaN }]);
    await expect(backfillKnown({ cloudflareClient: nan.cloudflareClient, gallery, model: 'm1' })).rejects.toThrow(
      /cursor/i
    );
  });

  it('reports progress per page', async () => {
    const s = setup([{ faces: [face('f1', 0)], nextCursor: 3 }, { faces: [] }]);
    const onProgress = vi.fn();
    await backfillKnown({ cloudflareClient: s.cloudflareClient, gallery, model: 'm1', dryRun: true, onProgress });
    expect(onProgress).toHaveBeenCalledTimes(2);
  });
});
