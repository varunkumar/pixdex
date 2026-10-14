import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerApiClient } from '../WorkerApiClient';

describe('WorkerApiClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: WorkerApiClient;

  beforeEach(() => {
    fetchMock = vi.fn();
    client = new WorkerApiClient('/api', fetchMock as unknown as typeof fetch, () => false);
  });

  it('search() builds the query string, and returns results', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [{ id: 'p1', thumbnailUrl: '/thumbnails/h1' }] }), { status: 200 })
    );

    const results = await client.search({ q: 'big cat', album: 'Kanha' });

    expect(results).toEqual([{ id: 'p1', thumbnailUrl: '/thumbnails/h1' }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/search?q=big+cat&album=Kanha');
    expect(init).toEqual({ redirect: 'manual' });
  });

  it('calls the default fetch unbound (window.fetch throws "Illegal invocation" otherwise)', async () => {
    const strictFetch = vi.fn(function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(new Response(JSON.stringify({ results: [], total: 0 }), { status: 200 }));
    });
    vi.stubGlobal('fetch', strictFetch);

    const defaultClient = new WorkerApiClient('/api');
    await expect(defaultClient.search({})).resolves.toEqual([]);
    vi.unstubAllGlobals();
  });

  it('getAlbums() returns the albums array', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ albums: ['Kanha', 'Kaziranga'] }), { status: 200 }));
    expect(await client.getAlbums()).toEqual(['Kanha', 'Kaziranga']);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/albums?names=1');
  });

  it('getAlbumsPage() requests limit and offset and returns the page', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ albums: [], total: 0 }), { status: 200 }));
    const page = await client.getAlbumsPage({ limit: 12, offset: 24 });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/albums?limit=12&offset=24');
    expect(page).toEqual({ albums: [], total: 0 });
  });

  it('getAlbumsPage() always sends a limit so the worker returns the rich shape', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ albums: [], total: 0 }), { status: 200 }));
    await client.getAlbumsPage();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/albums?limit=12');
  });

  it('searchPage() forwards sort=date', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ results: [], total: 0 }), { status: 200 }));
    await client.searchPage({ album: 'Kanha', sort: 'date', limit: 12, offset: 0 });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/search?album=Kanha&sort=date&limit=12&offset=0');
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

  it('thumbnailUrl() joins the base URL with the relative path and carries no token', () => {
    expect(client.thumbnailUrl({ thumbnailUrl: '/thumbnails/h1' })).toBe('/api/thumbnails/h1');
  });

  it('thumbnailUrl() returns an empty string when there is no thumbnail', () => {
    expect(client.thumbnailUrl({ thumbnailUrl: undefined })).toBe('');
  });

  it('reports an expired sign-in when the redirect leads somewhere fetch cannot follow', async () => {
    // Cloudflare Access answers an expired session with a cross-origin redirect to its login page.
    fetchMock
      .mockResolvedValueOnce({ type: 'opaqueredirect', ok: false, status: 0 } as unknown as Response)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(client.getDailyPick()).rejects.toThrow(/session has expired/i);
  });

  it('follows a redirect that fetch can follow (Access refreshing a live session) instead of failing', async () => {
    fetchMock
      .mockResolvedValueOnce({ type: 'opaqueredirect', ok: false, status: 0 } as unknown as Response)
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'p1' }), { status: 200 }));
    await expect(client.getPhoto('p1')).resolves.toEqual({ id: 'p1' });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/photos/p1');
  });

  it('reloads the page once so Access can refresh the session when its redirect cannot be followed', async () => {
    const reload = vi.fn(() => true);
    const c = new WorkerApiClient('/api', fetchMock as unknown as typeof fetch, reload);
    fetchMock
      .mockResolvedValueOnce({ type: 'opaqueredirect', ok: false, status: 0 } as unknown as Response)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(c.getDailyPick()).rejects.toThrow(/session has expired/i);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('names the path when the network request itself fails', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(client.getDailyPick()).rejects.toThrow(/\/daily-pick.*Failed to fetch/);
  });
});
