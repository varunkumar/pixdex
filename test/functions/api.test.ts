import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequestGet } from '../../functions/api/[[path]]';

const env = { WORKER_URL: 'https://worker.example.dev/', READ_TOKEN: 'secret-token' };

function call(path: string, headers: Record<string, string> = {}, e = env) {
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

  it.each(['/api/albums', '/api/daily-pick', '/api/photos/p1', '/api/thumbnails/abc123'])(
    'allows %s',
    async (path) => {
      expect((await call(path)).status).toBe(200);
    }
  );

  it.each(['/api/ingest/photo', '/api/health', '/api/photos', '/api/photos/a/b', '/api/'])(
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
});
