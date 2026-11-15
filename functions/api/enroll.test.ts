// @vitest-environment node
// The public enroll endpoint and page: the only routes of the invite-only feature reachable without
// Cloudflare Access, so these tests treat every input as hostile.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_BODY_BYTES, onRequest, onRequestPost } from './enroll';
import { onRequest as enrollPageAny, onRequestGet as enrollPage } from '../enroll';
import { SITEVERIFY_URL } from '../_lib/turnstile';

const env = {
  WORKER_URL: 'https://worker.example.dev/',
  READ_TOKEN: 'secret-token',
  TURNSTILE_SECRET: 'turnstile-secret',
  TURNSTILE_SITE_KEY: '0x4AAAAAAAsitekey',
};

describe('POST /api/enroll', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let siteverify: () => Promise<Response>;
  let worker: () => Promise<Response>;

  beforeEach(() => {
    siteverify = async () => Response.json({ success: true });
    worker = async () =>
      new Response('{"ok":true}', {
        status: 202,
        headers: { 'content-type': 'application/json', 'set-cookie': 'a=b', 'x-internal': 'leak' },
      });
    fetchMock = vi.fn(async (input: RequestInfo | URL) => (String(input) === SITEVERIFY_URL ? siteverify() : worker()));
    vi.stubGlobal('fetch', fetchMock);
  });

  const workerCalls = () => fetchMock.mock.calls.filter(([url]) => String(url) !== SITEVERIFY_URL);
  const verifyCalls = () => fetchMock.mock.calls.filter(([url]) => String(url) === SITEVERIFY_URL);

  function post(body: string, headers: Record<string, string> = {}, e: Record<string, string | undefined> = env) {
    return onRequestPost({
      request: new Request('https://pixdex.example.dev/api/enroll', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.9', ...headers },
        body,
      }),
      env: e,
    });
  }
  const valid = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ email: ' Friend@Example.com ', note: ' hi there ', token: 'tok', ...extra });

  it('verifies Turnstile then forwards with the bearer, X-Client-IP and the cleaned JSON body', async () => {
    const res = await post(valid());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-internal')).toBeNull();

    const verifyBody = new URLSearchParams(verifyCalls()[0][1].body as string);
    expect(verifyBody.get('secret')).toBe('turnstile-secret');
    expect(verifyBody.get('response')).toBe('tok');
    expect(verifyBody.get('remoteip')).toBe('203.0.113.9');

    const [[url, init]] = workerCalls();
    expect(String(url)).toBe('https://worker.example.dev/enroll');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ email: 'friend@example.com', note: 'hi there' });
  });

  it('sends only the allowed upstream headers, never the client ones', async () => {
    await post(valid(), {
      Cookie: 'CF_Authorization=session',
      Authorization: 'Bearer client-supplied',
      'X-Viewer-Email': 'owner@example.com',
      'X-Client-IP': '198.51.100.1',
      'Cf-Access-Jwt-Assertion': 'jwt',
    });
    const h = new Headers(workerCalls()[0][1].headers);
    expect([...h.keys()].sort()).toEqual(['authorization', 'content-type', 'x-client-ip']);
    expect(h.get('authorization')).toBe('Bearer secret-token');
    expect(h.get('content-type')).toBe('application/json');
    expect(h.get('x-client-ip')).toBe('203.0.113.9');
  });

  it('omits X-Client-IP and remoteip when CF-Connecting-IP is absent', async () => {
    const res = await onRequestPost({
      request: new Request('https://pixdex.example.dev/api/enroll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: valid(),
      }),
      env,
    });
    expect(res.status).toBe(202);
    expect(new URLSearchParams(verifyCalls()[0][1].body as string).has('remoteip')).toBe(false);
    expect(new Headers(workerCalls()[0][1].headers).has('x-client-ip')).toBe(false);
  });

  it.each([
    ['absent', { note: undefined }],
    ['empty', { note: '' }],
    ['only spaces', { note: '    ' }],
  ])('drops a note that is %s instead of sending null or an empty string', async (_name, extra) => {
    await post(valid(extra));
    const sent = JSON.parse(workerCalls()[0][1].body as string);
    expect(sent).toEqual({ email: 'friend@example.com' });
    expect('note' in sent).toBe(false);
  });

  it('does not need an Access JWT', async () => {
    const res = await post(valid());
    expect(res.status).toBe(202);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('cloudflareaccess.com'))).toBe(false);
  });

  it('returns 403 with no Worker call when the token is missing', async () => {
    const res = await post(JSON.stringify({ email: 'a@example.com' }));
    expect(res.status).toBe(403);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(workerCalls()).toHaveLength(0);
  });

  it('returns 403 with no Worker call when Turnstile says no', async () => {
    siteverify = async () => Response.json({ success: false });
    expect((await post(valid())).status).toBe(403);
    expect(workerCalls()).toHaveLength(0);
  });

  it('returns 403 with no Worker call when siteverify is unreachable', async () => {
    siteverify = async () => {
      throw new TypeError('network');
    };
    expect((await post(valid())).status).toBe(403);
    expect(workerCalls()).toHaveLength(0);
  });

  it.each([429, 400])('relays a Worker %i with its JSON body and no-store', async (status) => {
    worker = async () => Response.json({ error: 'x' }, { status, headers: { 'set-cookie': 'a=b' } });
    const res = await post(valid());
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: 'x' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('returns 502 when the Worker is unreachable', async () => {
    worker = async () => {
      throw new TypeError('network');
    };
    const res = await post(valid());
    expect(res.status).toBe(502);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it.each([401, 404, 500, 503, 302])(
    'maps a Worker %i to a generic 502 with nothing from the upstream in it',
    async (status) => {
      worker = async () =>
        new Response('{"error":"Unauthorized: READ_TOKEN mismatch at worker.internal"}', {
          status,
          headers: { 'content-type': 'application/json', 'set-cookie': 'a=b', 'x-internal': 'leak' },
        });
      const res = await post(valid());
      expect(res.status).toBe(502);
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(res.headers.get('x-internal')).toBeNull();
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: 'Upstream unavailable' });
      expect(text).not.toMatch(/READ_TOKEN|Unauthorized|worker\.internal/);
    },
  );

  it('returns 400 for malformed JSON without calling anything', async () => {
    const res = await post('{"email":');
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['an array', '[]'],
    ['null', 'null'],
    ['a missing email', JSON.stringify({ token: 'tok' })],
    ['a numeric email', JSON.stringify({ email: 1, token: 'tok' })],
    ['a blank email', JSON.stringify({ email: '   ', token: 'tok' })],
    ['an email without @', JSON.stringify({ email: 'nobody', token: 'tok' })],
    ['an email over 254 characters', JSON.stringify({ email: `${'a'.repeat(243)}@example.com`, token: 'tok' })],
    ['a null note', JSON.stringify({ email: 'a@example.com', note: null, token: 'tok' })],
    ['a numeric note', JSON.stringify({ email: 'a@example.com', note: 5, token: 'tok' })],
    ['a note over 200 characters', JSON.stringify({ email: 'a@example.com', note: 'n'.repeat(201), token: 'tok' })],
  ])('returns 400 for %s without calling anything', async (_name, body) => {
    expect((await post(body)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a 254-character email and a 200-character note after trimming', async () => {
    const email = `${'a'.repeat(242)}@example.com`;
    expect(email).toHaveLength(254);
    const res = await post(JSON.stringify({ email: ` ${email} `, note: ` ${'n'.repeat(200)} `, token: 'tok' }));
    expect(res.status).toBe(202);
    expect(JSON.parse(workerCalls()[0][1].body as string)).toEqual({ email, note: 'n'.repeat(200) });
  });

  it('returns 413 for a body over the cap without calling anything', async () => {
    const res = await post(JSON.stringify({ email: 'a@example.com', token: 'x'.repeat(MAX_BODY_BYTES) }));
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 413 when the declared Content-Length is over the cap', async () => {
    const res = await post(valid(), { 'content-length': String(MAX_BODY_BYTES + 1) });
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fits the largest valid body (2048-character token, full email and multi-byte note) under the cap', async () => {
    const body = JSON.stringify({ email: `${'a'.repeat(242)}@example.com`, note: '\u{1F600}'.repeat(100), token: 't'.repeat(2048) });
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect((await post(body)).status).toBe(202);
  });

  it('returns 415 for a non-JSON content type without calling anything', async () => {
    const res = await post(valid(), { 'content-type': 'text/plain' });
    expect(res.status).toBe(415);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['TURNSTILE_SECRET', 'TURNSTILE_SITE_KEY', 'WORKER_URL', 'READ_TOKEN'])(
    'returns 503 without calling anything when %s is unset',
    async (name) => {
      const res = await post(valid(), {}, { ...env, [name]: undefined });
      expect(res.status).toBe(503);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])('refuses %s with 405 and calls nothing', async (method) => {
    const res = await onRequest({
      request: new Request('https://pixdex.example.dev/api/enroll', { method }),
      env,
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('handles POST through the catch-all handler too', async () => {
    const res = await onRequest({
      request: new Request('https://pixdex.example.dev/api/enroll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: valid(),
      }),
      env,
    });
    expect(res.status).toBe(202);
  });
});

describe('GET /enroll', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  const page = (e: Record<string, string | undefined> = env) => enrollPage({ env: e });

  it('serves a self-contained page with the site key and no bundle assets', async () => {
    const res = await page();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await res.text();
    expect(html).toContain('data-sitekey="0x4AAAAAAAsitekey"');
    expect(html).toContain('https://challenges.cloudflare.com/turnstile/v0/api.js');
    expect(html).not.toContain('/assets/');
    expect(html).toMatch(/<input[^>]*name="email"/);
    expect(html).toMatch(/<textarea[^>]*maxlength="200"/);
    expect(html).toContain('/api/enroll');
    expect(html).toContain('Request received');
    expect(html).not.toContain('innerHTML');
    expect(html).not.toContain('secret-token');
    expect(html).not.toContain('turnstile-secret');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sets strict security headers with a per-response nonce used by every inline script and style', async () => {
    const res = await page();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const csp = res.headers.get('content-security-policy') ?? '';
    const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    for (const directive of [
      "default-src 'none'",
      `script-src 'nonce-${nonce}' https://challenges.cloudflare.com`,
      `style-src 'nonce-${nonce}'`,
      'frame-src https://challenges.cloudflare.com',
      "connect-src 'self' https://challenges.cloudflare.com",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ]) {
      expect(csp).toContain(directive);
    }
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    const html = await res.text();
    const tags = html.match(/<(script|style)\b[^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThanOrEqual(3);
    for (const tag of tags) expect(tag).toContain(`nonce="${nonce}"`);

    const other = (await page()).headers.get('content-security-policy');
    expect(other).not.toBe(csp);
  });

  it.each(['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])('refuses %s with 405, Allow: GET, HEAD and no-store', async (method) => {
    const res = await enrollPageAny({ request: new Request('https://pixdex.example.dev/enroll', { method }), env });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('still serves the page for GET and does not refuse HEAD through the catch-all handler', async () => {
    const get = await enrollPageAny({ request: new Request('https://pixdex.example.dev/enroll'), env });
    expect(get.status).toBe(200);
    expect(await get.text()).toContain('data-sitekey');
    const head = await enrollPageAny({ request: new Request('https://pixdex.example.dev/enroll', { method: 'HEAD' }), env });
    expect(head.status).not.toBe(405);
    expect(head.status).toBe(200);
    expect(head.headers.get('cache-control')).toBe('no-store');
  });

  it('escapes a hostile site key into the attribute', async () => {
    const html = await (await page({ ...env, TURNSTILE_SITE_KEY: `"><script>alert(1)</script>&'` })).text();
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('data-sitekey="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;&#39;"');
  });

  it.each([
    ['TURNSTILE_SITE_KEY', undefined],
    ['TURNSTILE_SITE_KEY', ''],
    ['TURNSTILE_SITE_KEY', '   '],
    ['TURNSTILE_SECRET', undefined],
  ])('says enrolment is not available without a widget when %s is %j', async (name, value) => {
    const res = await page({ ...env, [name]: value });
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('not available');
    expect(html).not.toContain('challenges.cloudflare.com/turnstile');
    expect(html).not.toContain('data-sitekey');
    expect(html).not.toContain('<form');
  });
});
