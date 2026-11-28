import { describe, expect, it, vi } from 'vitest';
import { backfillPlaces } from '../src/backfillPlaces';
import { runBackfillPlaces } from '../src/placesCli';
import { CloudflareClient } from '../src/cloudflareClient';
import { parseGazetteer } from '../src/places/gazetteer';

const gazetteer = parseGazetteer(['1', 'Gundlupet', 'Gundlupet', '', '11.81', '76.69', 'P', 'PPL', 'IN'].join('\t'));
const item = (contentHash: string, latitude = 11.67) => ({ contentHash, latitude, longitude: 76.63 });

const client = (pages: { items: ReturnType<typeof item>[]; nextCursor: number | null }[]) => {
  const placesPending = vi.fn();
  pages.forEach((p) => placesPending.mockResolvedValueOnce(p));
  return { placesPending, ingestPlaces: vi.fn(async (photos: unknown[]) => ({ updated: photos.length, unknown: 0 })) };
};

describe('backfillPlaces', () => {
  it('pages to the end and writes one batch for each page', async () => {
    const cloudflareClient = client([
      { items: Array.from({ length: 100 }, (_, i) => item(`a${i}`)), nextCursor: 100 },
      { items: [item('far', 0)], nextCursor: null },
    ]);
    const result = await backfillPlaces({ cloudflareClient, gazetteer });
    expect(result).toEqual({ total: 101, placed: 100, none: 1, notIndexed: 0 });
    expect(cloudflareClient.placesPending.mock.calls).toEqual([[0, 100], [100, 100]]);
    expect(cloudflareClient.ingestPlaces.mock.calls.map(([photos]) => photos.length)).toEqual([100, 1]);
    expect(cloudflareClient.ingestPlaces.mock.calls[1][0]).toEqual([{ contentHash: 'far', place: '' }]);
  });

  it('writes nothing on a dry run, and nothing for an empty page', async () => {
    const cloudflareClient = client([{ items: [item('a')], nextCursor: null }]);
    expect(await backfillPlaces({ cloudflareClient, gazetteer, dryRun: true })).toMatchObject({ total: 1, placed: 1 });
    const empty = client([{ items: [], nextCursor: null }]);
    await backfillPlaces({ cloudflareClient: empty, gazetteer });
    expect(cloudflareClient.ingestPlaces).not.toHaveBeenCalled();
    expect(empty.ingestPlaces).not.toHaveBeenCalled();
  });

  it('tells how to download the town list when the file is missing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cloudflareClient = client([]);
    expect(await runBackfillPlaces([], { cloudflareClient, loadGazetteer: async () => undefined })).toBe(1);
    expect(error.mock.calls.flat().join('\n')).toContain('https://download.geonames.org/export/dump/cities500.zip');
    expect(cloudflareClient.placesPending).not.toHaveBeenCalled();
    expect(await runBackfillPlaces(['--nope'], { cloudflareClient, loadGazetteer: async () => gazetteer })).toBe(1);
    error.mockRestore();
  });

  it('sends the pending and write requests to the ingest routes', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ items: [], nextCursor: null, updated: 1, unknown: 0 })));
    const real = new CloudflareClient({ CLOUDFLARE_API_BASE_URL: 'https://w.example', INGEST_TOKEN: 't' } as never, fetchFn as never);
    await real.placesPending(5, 100);
    await real.ingestPlaces([{ contentHash: 'h', place: 'X, IN' }]);
    const calls = fetchFn.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url, init]) => [url, JSON.parse(init.body as string)])).toEqual([
      ['https://w.example/ingest/places/pending', { cursor: 5, limit: 100 }],
      ['https://w.example/ingest/places', { photos: [{ contentHash: 'h', place: 'X, IN' }] }],
    ]);
  });
});
