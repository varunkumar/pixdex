import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerApiClient } from '../WorkerApiClient';

describe('WorkerApiClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: WorkerApiClient;

  beforeEach(() => {
    fetchMock = vi.fn();
    client = new WorkerApiClient('/api', fetchMock as unknown as typeof fetch, () => false);
  });

  it('updatePhoto PATCHes the review and returns the updated photo', async () => {
    fetchMock.mockResolvedValue({ ok: true, type: 'basic', json: async () => ({ id: 'p1', userRating: 4 }) });
    const photo = await client.updatePhoto('p1', { userRating: 4 });
    expect(photo.userRating).toBe(4);
    expect(fetchMock).toHaveBeenCalledWith('/api/photos/p1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{"userRating":4}',
    });
  });

  it('updatePhoto throws on a failed save', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400 });
    await expect(client.updatePhoto('p1', { userRating: 4 })).rejects.toThrow('Could not save: 400');
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

  describe('people and faces', () => {
    const ok = (body: unknown) => ({ ok: true, type: 'basic', status: 200, json: async () => body });
    const face = { id: 'f1', personId: null };
    const jsonInit = (method: string, body: unknown) => ({
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    it('getPeople unwraps the people list', async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ people: [{ id: 'a' }] }), { status: 200 }));
      await expect(client.getPeople()).resolves.toEqual([{ id: 'a' }]);
      expect(fetchMock.mock.calls[0][0]).toBe('/api/people');
    });

    it('getFaceGroups sends the cursor', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ groups: [], scanned: 3, nextCursor: '9' }), { status: 200 })
      );
      const res = await client.getFaceGroups('5');
      expect(res).toEqual({ groups: [], scanned: 3, nextCursor: '9' });
      expect(fetchMock.mock.calls[0][0]).toBe('/api/people/groups?cursor=5');
    });

    it('getFaceGroups without a cursor sends none', async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ groups: [], scanned: 0, nextCursor: null })));
      await client.getFaceGroups();
      expect(fetchMock.mock.calls[0][0]).toBe('/api/people/groups');
    });

    it('getPhotoFaces unwraps the faces', async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ faces: [face] }), { status: 200 }));
      await expect(client.getPhotoFaces('p 1')).resolves.toEqual([face]);
      expect(fetchMock.mock.calls[0][0]).toBe('/api/photos/p%201/faces');
    });

    it('createPerson POSTs the name and face ids', async () => {
      fetchMock.mockResolvedValue(ok({ id: 'n1', name: 'Asha' }));
      await expect(client.createPerson('Asha', ['f1'])).resolves.toEqual({ id: 'n1', name: 'Asha' });
      expect(fetchMock).toHaveBeenCalledWith('/api/people', jsonInit('POST', { name: 'Asha', faceIds: ['f1'] }));
    });

    it('renamePerson PATCHes the name', async () => {
      fetchMock.mockResolvedValue(ok({ id: 'n1', name: 'B' }));
      await client.renamePerson('n1', 'B');
      expect(fetchMock).toHaveBeenCalledWith('/api/people/n1', jsonInit('PATCH', { name: 'B' }));
    });

    it('deletePerson DELETEs and tolerates an empty 204 body', async () => {
      fetchMock.mockResolvedValue({ ok: true, type: 'basic', status: 204 });
      await expect(client.deletePerson('n1')).resolves.toBeUndefined();
      expect(fetchMock.mock.calls[0][0]).toBe('/api/people/n1');
      expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
    });

    it('assignFaces POSTs the face ids to the person', async () => {
      fetchMock.mockResolvedValue(ok({ personId: 'n1', assigned: 2 }));
      await client.assignFaces('n1', ['f1', 'f2']);
      expect(fetchMock).toHaveBeenCalledWith('/api/people/n1/faces', jsonInit('POST', { faceIds: ['f1', 'f2'] }));
    });

    it('setPersonCover POSTs the face id to the person', async () => {
      fetchMock.mockResolvedValue(ok({ coverFaceId: 'f1' }));
      await client.setPersonCover('n 1', 'f1');
      expect(fetchMock).toHaveBeenCalledWith('/api/people/n%201/cover', jsonInit('POST', { faceId: 'f1' }));
    });

    it('assignFace POSTs the person id and returns the face', async () => {
      fetchMock.mockResolvedValue(ok(face));
      await expect(client.assignFace('f1', 'n1')).resolves.toEqual(face);
      expect(fetchMock).toHaveBeenCalledWith('/api/faces/f1/assign', jsonInit('POST', { personId: 'n1' }));
    });

    it('rejectFace POSTs the person id and returns the face', async () => {
      fetchMock.mockResolvedValue(ok(face));
      await expect(client.rejectFace('f1', 'n1')).resolves.toEqual(face);
      expect(fetchMock).toHaveBeenCalledWith('/api/faces/f1/reject', jsonInit('POST', { personId: 'n1' }));
    });

    it('unassignFace POSTs and returns the face', async () => {
      fetchMock.mockResolvedValue(ok(face));
      await expect(client.unassignFace('f1')).resolves.toEqual(face);
      expect(fetchMock.mock.calls[0][0]).toBe('/api/faces/f1/unassign');
      expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    });

    it('matchPerson POSTs apply and cursor', async () => {
      const res = { auto: [], suggestions: [], scanned: 1, nextCursor: null };
      fetchMock.mockResolvedValue(ok(res));
      await expect(client.matchPerson('n1', { apply: true, cursor: '7' })).resolves.toEqual(res);
      expect(fetchMock).toHaveBeenCalledWith('/api/people/n1/match', jsonInit('POST', { apply: true, cursor: '7' }));
    });

    it('matchPersonAll follows the cursor until it is null and sums the matches', async () => {
      fetchMock
        .mockResolvedValueOnce(ok({ auto: [face, face], suggestions: [], scanned: 300, nextCursor: '300' }))
        .mockResolvedValueOnce(ok({ auto: [face], suggestions: [], scanned: 40, nextCursor: null }));
      const onPage = vi.fn();
      await expect(client.matchPersonAll('n1', onPage)).resolves.toEqual({ matched: 3, truncated: false });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ apply: true });
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ apply: true, cursor: '300' });
      expect(onPage).toHaveBeenNthCalledWith(1, 300, 2);
      expect(onPage).toHaveBeenNthCalledWith(2, 340, 3);
    });

    it('matchPersonAll stops after 150 pages and reports it was truncated', async () => {
      fetchMock.mockResolvedValue(ok({ auto: [], suggestions: [], scanned: 1, nextCursor: 'more' }));
      await expect(client.matchPersonAll('n1')).resolves.toEqual({ matched: 0, truncated: true });
      expect(fetchMock).toHaveBeenCalledTimes(150);
    });

    it('search sends people as a comma list', async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ results: [], total: 0 })));
      await client.search({ people: ['a', 'b'] });
      expect(fetchMock.mock.calls[0][0]).toBe('/api/search?people=a%2Cb');
    });

    it('a failed write throws with the status', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 409 });
      await expect(client.renamePerson('n1', 'B')).rejects.toThrow('409');
    });
  });
});
