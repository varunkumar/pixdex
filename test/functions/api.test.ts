import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequestDelete, onRequestGet, onRequestPatch, onRequestPost, onRequestPut } from '../../functions/api/[[path]]';

const env = {
  WORKER_URL: 'https://worker.example.dev/',
  READ_TOKEN: 'secret-token',
  ORIGINALS_BASE_URL: 'https://originals.example.dev',
  ORIGINALS_TOKEN: 'originals-token',
};

function call(path: string, headers: Record<string, string> = {}, e: Record<string, string> = env) {
  return onRequestGet({
    request: new Request(`https://pixdex.example.dev${path}`, { headers }),
    env: e,
  });
}

describe('/api proxy', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  it('forwards allowed read routes with the server-side bearer token', async () => {
    const res = await call('/api/search?q=tiger&album=Kanha');
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://worker.example.dev/search?q=tiger&album=Kanha');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer secret-token');
  });

  it.each([
    '/api/albums',
    '/api/albums?limit=12&offset=0',
    '/api/albums?names=1',
    '/api/daily-pick', '/api/photos/p1',
    '/api/thumbnails/abc123',
    '/api/people',
    '/api/people/groups',
    '/api/photos/p1/faces',
  ])(
    'allows %s',
    async (path) => {
      expect((await call(path)).status).toBe(200);
    }
  );

  it.each(['/api/ingest/photo', '/api/health', '/api/photos', '/api/photos/a/b', '/api/', '/api/ingest/faces', '/api/people/p1', '/api/faces/f1/assign'])(
    'rejects %s without calling the worker',
    async (path) => {
      expect((await call(path)).status).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('drops client Authorization, cookies and ?token=', async () => {
    await call('/api/thumbnails/h1?token=leaked', {
      authorization: 'Bearer client',
      cookie: 'CF_Authorization=abc',
      'if-none-match': '"etag"',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://worker.example.dev/thumbnails/h1');
    const h = new Headers(init.headers);
    expect(h.get('authorization')).toBe('Bearer secret-token');
    expect(h.get('cookie')).toBeNull();
    expect(h.get('if-none-match')).toBe('"etag"');
  });

  it('returns 500 when not configured', async () => {
    expect((await call('/api/albums', {}, { WORKER_URL: '', READ_TOKEN: '' })).status).toBe(500);
  });

  describe('originals', () => {
    it('forwards to the tunnel with the originals token, not the read token', async () => {
      const res = await call('/api/originals/p1?token=leaked', { accept: 'image/*' });
      expect(res.status).toBe(200);
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe('https://originals.example.dev/originals/p1');
      const h = new Headers(init.headers);
      expect(h.get('authorization')).toBe('Bearer originals-token');
      expect(h.get('accept')).toBe('image/*');
    });

    it('adds Access service-token headers for originals only, when configured', async () => {
      const withAccess = { ...env, ACCESS_CLIENT_ID: 'id.access', ACCESS_CLIENT_SECRET: 'sek' };
      await call('/api/originals/p1', {}, withAccess);
      const o = new Headers(fetchMock.mock.calls[0][1].headers);
      expect(o.get('cf-access-client-id')).toBe('id.access');
      expect(o.get('cf-access-client-secret')).toBe('sek');

      await call('/api/albums', {}, withAccess);
      const w = new Headers(fetchMock.mock.calls[1][1].headers);
      expect(w.get('cf-access-client-id')).toBeNull();
      expect(w.get('cf-access-client-secret')).toBeNull();
    });

    it('omits Access headers when the service token is not configured', async () => {
      await call('/api/originals/p1');
      expect(new Headers(fetchMock.mock.calls[0][1].headers).get('cf-access-client-id')).toBeNull();
    });

    it('does not use the originals token for worker routes', async () => {
      await call('/api/albums');
      expect(new Headers(fetchMock.mock.calls[0][1].headers).get('authorization')).toBe('Bearer secret-token');
    });

    it('returns 500 when the tunnel is not configured', async () => {
      const res = await call('/api/originals/p1', {}, { WORKER_URL: env.WORKER_URL, READ_TOKEN: env.READ_TOKEN });
      expect(res.status).toBe(500);
    });

    it('returns 502 when the tunnel is unreachable', async () => {
      fetchMock.mockRejectedValueOnce(new Error('connect failed'));
      expect((await call('/api/originals/p1')).status).toBe(502);
    });

    it('never passes upstream cookies to the browser', async () => {
      // The tunnel's Access app answers service-token requests with its own
      // CF_Authorization cookie. Forwarding it would overwrite the user's session
      // cookie for the Pages origin and break every later /api call.
      const upstream = new Response('img', {
        status: 200,
        headers: [
          ['content-type', 'image/jpeg'],
          ['set-cookie', 'CF_Authorization=tunnel-jwt; Path=/; Secure; HttpOnly'],
          ['set-cookie', '__cf_bm=x; Path=/'],
        ],
      });
      fetchMock.mockResolvedValueOnce(upstream);
      const res = await call('/api/originals/p1');
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(res.headers.get('content-type')).toBe('image/jpeg');
    });

    it('rejects nested originals paths', async () => {
      expect((await call('/api/originals/a/b')).status).toBe(404);
    });
  });

  describe('Cache-Control', () => {
    it('revalidates API data on every request', async () => {
      for (const path of ['/api/search?q=x', '/api/albums', '/api/daily-pick', '/api/photos/p1']) {
        expect((await call(path)).headers.get('cache-control')).toBe('private, no-cache');
      }
    });

    it('caches content-addressed thumbnails as immutable', async () => {
      const res = await call('/api/thumbnails/abc123');
      expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    });

    it('caches originals briefly', async () => {
      const res = await call('/api/originals/p1');
      expect(res.headers.get('cache-control')).toBe('private, max-age=3600');
    });

    it('never caches error responses', async () => {
      fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }));
      const res = await call('/api/thumbnails/missing');
      expect(res.headers.get('cache-control')).toBe('no-store');
    });
  });
});

describe('/api proxy PUT', () => {
  const put = (path: string, type = 'application/json') =>
    onRequestPut({
      request: new Request(`https://pixdex.example.dev${path}`, {
        method: 'PUT',
        headers: { 'content-type': type },
        body: '{"album":"A","photoId":"p1"}',
      }),
      env,
    });
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  it('forwards only the album cover write, with the server-side token', async () => {
    expect((await put('/api/albums/cover')).status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://worker.example.dev/albums/cover');
    expect(init.method).toBe('PUT');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer secret-token');
  });

  it('rejects other paths and non-JSON bodies without calling the worker', async () => {
    expect((await put('/api/ingest/photo')).status).toBe(404);
    expect((await put('/api/albums/cover', 'text/plain')).status).toBe(415);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('/api proxy PATCH', () => {
  const patch = (path: string, type = 'application/json') =>
    onRequestPatch({
      request: new Request(`https://pixdex.example.dev${path}`, {
        method: 'PATCH',
        headers: { 'content-type': type },
        body: '{"userRating":4}',
      }),
      env,
    });
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  it('forwards the photo review write with the server-side token', async () => {
    expect((await patch('/api/photos/p1')).status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://worker.example.dev/photos/p1');
    expect(init.method).toBe('PATCH');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer secret-token');
  });

  it('rejects other paths and non-JSON bodies without calling the worker', async () => {
    expect((await patch('/api/ingest/photo')).status).toBe(404);
    expect((await patch('/api/photos/p1/x')).status).toBe(404);
    expect((await patch('/api/photos/p1', 'text/plain')).status).toBe(415);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('/api proxy POST, PATCH people, DELETE', () => {
  const send = (
    handler: typeof onRequestPost,
    method: string,
    path: string,
    type: string | null = 'application/json'
  ) =>
    handler({
      request: new Request(`https://pixdex.example.dev${path}`, {
        method,
        headers: type ? { 'content-type': type, cookie: 'CF_Authorization=abc' } : {},
        body: method === 'DELETE' ? undefined : '{"name":"Asha"}',
      }),
      env,
    });
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  it.each([
    '/api/people',
    '/api/people/p1/faces',
    '/api/people/p1/match',
    '/api/people/p1/cover',
    '/api/faces/f1/assign',
    '/api/faces/f1/reject',
    '/api/faces/f1/unassign',
  ])('POST forwards %s with the server-side token', async (path) => {
    const res = await send(onRequestPost, 'POST', path);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`https://worker.example.dev${path.replace('/api', '')}`);
    expect(init.method).toBe('POST');
    const h = new Headers(init.headers);
    expect(h.get('authorization')).toBe('Bearer secret-token');
    expect(h.get('cookie')).toBeNull();
    expect(init.body).toBe('{"name":"Asha"}');
  });

  it.each([
    '/api/ingest/faces',
    '/api/ingest/photo',
    '/api/people/groups',
    '/api/people/p1',
    '/api/people/p1/other',
    '/api/faces/f1',
    '/api/faces/f1/assign/x',
    '/api/photos/p1/faces',
    '/api/albums/cover',
  ])('POST rejects %s without calling the worker', async (path) => {
    expect((await send(onRequestPost, 'POST', path)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POST rejects non-JSON bodies with 415', async () => {
    expect((await send(onRequestPost, 'POST', '/api/people', 'text/plain')).status).toBe(415);
    expect((await send(onRequestPost, 'POST', '/api/people', null)).status).toBe(415);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('PATCH forwards people/<id> and still rejects people sub-paths', async () => {
    expect((await send(onRequestPatch, 'PATCH', '/api/people/p1')).status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://worker.example.dev/people/p1');
    expect((await send(onRequestPatch, 'PATCH', '/api/people/p1/faces')).status).toBe(404);
    expect((await send(onRequestPatch, 'PATCH', '/api/ingest/faces')).status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('DELETE forwards people/<id> only', async () => {
    expect((await send(onRequestDelete, 'DELETE', '/api/people/p1', null)).status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://worker.example.dev/people/p1');
    expect(init.method).toBe('DELETE');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer secret-token');
    for (const path of ['/api/people', '/api/people/p1/faces', '/api/photos/p1', '/api/ingest/faces', '/api/albums/cover']) {
      expect((await send(onRequestDelete, 'DELETE', path, null)).status).toBe(404);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('write handlers return 502 when the worker is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('down'));
    expect((await send(onRequestPost, 'POST', '/api/people')).status).toBe(502);
  });
});
