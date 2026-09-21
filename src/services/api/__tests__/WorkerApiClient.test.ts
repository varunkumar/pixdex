import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerApiClient } from '../WorkerApiClient';

describe('WorkerApiClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: WorkerApiClient;

  beforeEach(() => {
    fetchMock = vi.fn();
    client = new WorkerApiClient('https://example.workers.dev', fetchMock as unknown as typeof fetch);
  });

  it('search() builds the query string and returns results', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [{ id: 'p1', thumbnailUrl: '/thumbnails/h1' }] }), { status: 200 })
    );

    const results = await client.search({ q: 'big cat', album: 'Kanha' });

    expect(results).toEqual([{ id: 'p1', thumbnailUrl: '/thumbnails/h1' }]);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.workers.dev/search?q=big+cat&album=Kanha');
  });

  it('getAlbums() returns the albums array', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ albums: ['Kanha', 'Kaziranga'] }), { status: 200 }));
    expect(await client.getAlbums()).toEqual(['Kanha', 'Kaziranga']);
  });

  it('getPhoto() returns the photo or throws on 404', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'p1' }), { status: 200 }));
    expect(await client.getPhoto('p1')).toEqual({ id: 'p1' });

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(client.getPhoto('missing')).rejects.toThrow(/404/);
  });

  it('getDailyPick() returns the daily-pick payload', async () => {
    const payload = { photo: { id: 'p1' }, reason: 'r', suggestedCaption: 'c', suggestedHashtags: ['x'] };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }));
    expect(await client.getDailyPick()).toEqual(payload);
  });

  it('thumbnailUrl() joins the base URL with the relative path', () => {
    expect(client.thumbnailUrl({ thumbnailUrl: '/thumbnails/h1' })).toBe(
      'https://example.workers.dev/thumbnails/h1'
    );
  });
});
