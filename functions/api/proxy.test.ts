// @vitest-environment node
// Identity tests for the Pages Function: a real RS256 Access JWT, verified
// against a stubbed team JWKS, decides the X-Viewer-Email sent to the Worker.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequestGet, onRequestPost, onRequestPut } from './[[path]]';
import { resetJwksCache } from '../_lib/access';
import { AUD, CERTS_URL, TEAM_DOMAIN, certsResponse, makeKey, signJwt, validClaims, type TestKey } from '../../test/functions/accessJwt';

const env = {
  WORKER_URL: 'https://worker.example.dev',
  READ_TOKEN: 'secret-token',
  ORIGINALS_BASE_URL: 'https://originals.example.dev',
  ORIGINALS_TOKEN: 'originals-token',
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD: AUD,
};

describe('Pages Function identity', () => {
  let key: TestKey;
  let fetchMock: ReturnType<typeof vi.fn>;
  let accessStatus: number;

  beforeAll(async () => {
    key = await makeKey('k1');
  });

  beforeEach(() => {
    resetJwksCache();
    accessStatus = 204;
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === CERTS_URL) return certsResponse([key]);
      if (url.startsWith('https://worker.example.dev/access/photo/')) return new Response(null, { status: accessStatus });
      return new Response('{"ok":true}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  const upstreamCalls = () => fetchMock.mock.calls.filter(([url]) => String(url) !== CERTS_URL);

  async function get(path: string, email: string | null, extra: Record<string, string> = {}, e: typeof env = env) {
    const headers: Record<string, string> = { ...extra };
    if (email !== null) headers['Cf-Access-Jwt-Assertion'] = await signJwt(key, validClaims({ email }));
    return onRequestGet({ request: new Request(`https://pixdex.example.dev${path}`, { headers }), env: e });
  }

  it('returns 401 with no body detail and no upstream call when the JWT is missing', async () => {
    const res = await get('/api/albums', null);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('Unauthorized');
    expect(upstreamCalls()).toHaveLength(0);
  });

  it('returns 401 for an invalid JWT and ignores the plain Access email header', async () => {
    const res = await onRequestGet({
      request: new Request('https://pixdex.example.dev/api/albums', {
        headers: { 'Cf-Access-Jwt-Assertion': 'not.a.jwt', 'Cf-Access-Authenticated-User-Email': 'owner@example.com' },
      }),
      env,
    });
    expect(res.status).toBe(401);
    expect(upstreamCalls()).toHaveLength(0);
  });

  it('returns 401 for writes without a JWT', async () => {
    const res = await onRequestPost({
      request: new Request('https://pixdex.example.dev/api/people', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      env,
    });
    expect(res.status).toBe(401);
    expect(upstreamCalls()).toHaveLength(0);
  });

  it.each(['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD'])('fails closed when %s is unset', async (name) => {
    const res = await get('/api/albums', 'owner@example.com', {}, { ...env, [name]: '' });
    expect(res.status).toBe(500);
    expect(upstreamCalls()).toHaveLength(0);
  });

  it('forwards the verified email and drops a spoofed X-Viewer-Email', async () => {
    const res = await get('/api/albums', ' Friend@Example.com', { 'X-Viewer-Email': 'owner@example.com' });
    expect(res.status).toBe(200);
    const [[url, init]] = upstreamCalls();
    expect(String(url)).toBe('https://worker.example.dev/albums');
    const h = new Headers(init.headers);
    expect(h.get('x-viewer-email')).toBe('friend@example.com');
    expect(h.get('authorization')).toBe('Bearer secret-token');
  });

  it('allows GET me and PUT albums/shares with the verified email', async () => {
    expect((await get('/api/me', 'friend@example.com')).status).toBe(200);
    expect(String(upstreamCalls()[0][0])).toBe('https://worker.example.dev/me');

    const res = await onRequestPut({
      request: new Request('https://pixdex.example.dev/api/albums/shares', {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'Cf-Access-Jwt-Assertion': await signJwt(key, validClaims({ email: 'friend@example.com' })),
          'X-Viewer-Email': 'owner@example.com',
        },
        body: '{"album":"A","emails":[]}',
      }),
      env,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const [url, init] = upstreamCalls()[1];
    expect(String(url)).toBe('https://worker.example.dev/albums/shares');
    expect(init.method).toBe('PUT');
    expect(new Headers(init.headers).get('x-viewer-email')).toBe('friend@example.com');
  });

  describe('known personalities', () => {
    it('forwards GET people/known with the verified email, READ_TOKEN and the query string', async () => {
      const res = await get('/api/people/known?limit=5', ' Friend@Example.com');
      expect(res.status).toBe(200);
      const [[url, init]] = upstreamCalls();
      expect(String(url)).toBe('https://worker.example.dev/people/known?limit=5');
      const h = new Headers(init.headers);
      expect(h.get('x-viewer-email')).toBe('friend@example.com');
      expect(h.get('authorization')).toBe('Bearer secret-token');
    });

    it('forwards known= on search and timeline', async () => {
      await get('/api/search?q=a&known=1', 'friend@example.com');
      await get('/api/timeline?known=1', 'friend@example.com');
      expect(upstreamCalls().map(([u]) => String(u))).toEqual([
        'https://worker.example.dev/search?q=a&known=1',
        'https://worker.example.dev/timeline?known=1',
      ]);
    });

    it('refuses GET people/known without a valid Access JWT', async () => {
      const res = await get('/api/people/known', null);
      expect(res.status).toBe(401);
      expect(upstreamCalls()).toHaveLength(0);
    });

    it.each(['/api/ingest/known-people', '/api/ingest/faces/known', '/api/ingest/faces/embeddings'])(
      'does not proxy %s',
      async (path) => {
        const got = await get(path, 'friend@example.com');
        expect(got.status).toBe(404);
        const post = await onRequestPost({
          request: new Request(`https://pixdex.example.dev${path}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'Cf-Access-Jwt-Assertion': await signJwt(key, validClaims({ email: 'friend@example.com' })),
            },
            body: '{}',
          }),
          env,
        });
        expect([404, 405]).toContain(post.status);
        expect(upstreamCalls()).toHaveLength(0);
      },
    );
  });

  describe('originals', () => {
    it('returns 404 when the access check is 404, without calling the tunnel', async () => {
      accessStatus = 404;
      const res = await get('/api/originals/p1', 'friend@example.com');
      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const calls = upstreamCalls();
      expect(calls).toHaveLength(1);
      expect(String(calls[0][0])).toBe('https://worker.example.dev/access/photo/p1');
      const h = new Headers(calls[0][1].headers);
      expect(h.get('authorization')).toBe('Bearer secret-token');
      expect(h.get('x-viewer-email')).toBe('friend@example.com');
    });

    it('proxies an original when the access check is 204', async () => {
      const res = await get('/api/originals/p1', 'friend@example.com');
      expect(res.status).toBe(200);
      const calls = upstreamCalls();
      expect(calls.map(([url]) => String(url))).toEqual([
        'https://worker.example.dev/access/photo/p1',
        'https://originals.example.dev/originals/p1',
      ]);
      const h = new Headers(calls[1][1].headers);
      expect(h.get('authorization')).toBe('Bearer originals-token');
      expect(h.get('x-viewer-email')).toBeNull();
    });

    it('treats any other access check answer as not found', async () => {
      accessStatus = 401;
      expect((await get('/api/originals/p1', 'friend@example.com')).status).toBe(404);
      expect(upstreamCalls()).toHaveLength(1);
    });

    it('runs the access check for every user, including the album owner', async () => {
      const res = await get('/api/originals/p1', 'OWNER@example.COM');
      expect(res.status).toBe(200);
      const calls = upstreamCalls();
      expect(String(calls[0][0])).toBe('https://worker.example.dev/access/photo/p1');
      expect(new Headers(calls[0][1].headers).get('x-viewer-email')).toBe('owner@example.com');
      expect(String(calls[1][0])).toBe('https://originals.example.dev/originals/p1');
    });
  });
});
