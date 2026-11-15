// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SITEVERIFY_URL, verifyTurnstile } from './turnstile';

describe('verifyTurnstile', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let reply: () => Promise<Response>;

  beforeEach(() => {
    reply = async () => Response.json({ success: true });
    fetchMock = vi.fn(async () => reply());
    vi.stubGlobal('fetch', fetchMock);
  });

  it('posts secret, response and remoteip as a form and returns true on success', async () => {
    expect(await verifyTurnstile('tok', 'sec', '203.0.113.9')).toBe(true);
    const [[url, init]] = fetchMock.mock.calls;
    expect(String(url)).toBe(SITEVERIFY_URL);
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = new URLSearchParams(init.body as string);
    expect(new Headers(init.headers).get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(body.get('secret')).toBe('sec');
    expect(body.get('response')).toBe('tok');
    expect(body.get('remoteip')).toBe('203.0.113.9');
  });

  it('omits remoteip when the IP is unknown', async () => {
    expect(await verifyTurnstile('tok', 'sec', null)).toBe(true);
    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body as string);
    expect(body.has('remoteip')).toBe(false);
  });

  it.each([
    ['missing secret', 'tok', undefined],
    ['blank secret', 'tok', '  '],
    ['missing token', undefined, 'sec'],
    ['empty token', '', 'sec'],
    ['non-string token', 42, 'sec'],
    ['oversized token', 'x'.repeat(2049), 'sec'],
  ])('fails closed without calling siteverify: %s', async (_name, token, secret) => {
    expect(await verifyTurnstile(token, secret as string | undefined, null)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['success false', async () => Response.json({ success: false, 'error-codes': ['invalid-input-response'] })],
    ['success as a string', async () => Response.json({ success: 'true' })],
    ['non-2xx', async () => Response.json({ success: true }, { status: 500 })],
    ['non-JSON body', async () => new Response('oops', { status: 200 })],
    ['network error', async () => { throw new TypeError('network'); }],
    ['timeout', async () => { throw new DOMException('timed out', 'TimeoutError'); }],
  ])('fails closed on %s', async (_name, r) => {
    reply = r;
    expect(await verifyTurnstile('tok', 'sec', null)).toBe(false);
  });
});
