// @vitest-environment node
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetJwksCache, verifyAccessJwt } from './access';
import { AUD, CERTS_URL, TEAM_DOMAIN, certsResponse, makeKey, signJwt, validClaims, type TestKey } from '../../test/functions/accessJwt';

const env = { ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: AUD };

describe('verifyAccessJwt', () => {
  let key: TestKey;
  let other: TestKey;
  let fetchFn: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    key = await makeKey('k1');
    other = await makeKey('k2');
  });

  beforeEach(() => {
    resetJwksCache();
    fetchFn = vi.fn(async () => certsResponse([key]));
  });

  const verify = (token: string | null, e: typeof env = env) =>
    verifyAccessJwt(token, e, fetchFn as unknown as typeof fetch);

  it('returns the lowercased, trimmed email for a valid token', async () => {
    expect(await verify(await signJwt(key, validClaims()))).toEqual({ email: 'friend@example.com' });
    expect(fetchFn).toHaveBeenCalledWith(CERTS_URL);
  });

  it('accepts a string aud', async () => {
    expect(await verify(await signJwt(key, validClaims({ aud: AUD })))).toEqual({ email: 'friend@example.com' });
  });

  it('caches the JWKS across calls', async () => {
    await verify(await signJwt(key, validClaims()));
    await verify(await signJwt(key, validClaims()));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('refetches once when the kid is unknown (key rotation), at most once a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await verify(await signJwt(key, validClaims()));
      fetchFn.mockImplementation(async () => certsResponse([key, other]));
      // Within the cooldown an unknown kid does not trigger a refetch.
      expect(await verify(await signJwt(other, validClaims()))).toBeNull();
      expect(fetchFn).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 61_000);
      expect(await verify(await signJwt(other, validClaims()))).toEqual({ email: 'friend@example.com' });
      expect(fetchFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refetches the JWKS after an hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await verify(await signJwt(key, validClaims()));
      vi.setSystemTime(Date.now() + 3_601_000);
      await verify(await signJwt(key, validClaims()));
      expect(fetchFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns null for a token signed by a key not in the JWKS', async () => {
    const forged = await signJwt(other, validClaims(), { alg: 'RS256', kid: 'k1' });
    expect(await verify(forged)).toBeNull();
  });

  it('returns null for an unknown kid even after one refetch', async () => {
    expect(await verify(await signJwt(other, validClaims()))).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('returns null for a tampered payload', async () => {
    const [h, , s] = (await signJwt(key, validClaims())).split('.');
    const p = Buffer.from(JSON.stringify(validClaims({ email: 'owner@example.com' }))).toString('base64url');
    expect(await verify(`${h}.${p}.${s}`)).toBeNull();
  });

  it('returns null for the wrong aud', async () => {
    expect(await verify(await signJwt(key, validClaims({ aud: ['other-aud'] })))).toBeNull();
    expect(await verify(await signJwt(key, validClaims({ aud: undefined })))).toBeNull();
  });

  it('returns null for an expired token or one without exp', async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await verify(await signJwt(key, validClaims({ exp: now - 1 })))).toBeNull();
    expect(await verify(await signJwt(key, validClaims({ exp: undefined })))).toBeNull();
  });

  it('returns null for a token that is not valid yet', async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await verify(await signJwt(key, validClaims({ nbf: now + 600 })))).toBeNull();
  });

  it('returns null for a token without an email claim', async () => {
    expect(await verify(await signJwt(key, validClaims({ email: undefined })))).toBeNull();
    expect(await verify(await signJwt(key, validClaims({ email: '  ' })))).toBeNull();
  });

  it('rejects any alg other than RS256', async () => {
    expect(await verify(await signJwt(key, validClaims(), { alg: 'none', kid: 'k1' }))).toBeNull();
    expect(await verify(await signJwt(key, validClaims(), { alg: 'HS256', kid: 'k1' }))).toBeNull();
  });

  it.each([null, '', 'abc', 'a.b', 'a.b.c', 'a.b.c.d', '!!!.@@@.###'])('returns null for malformed token %j', async (token) => {
    expect(await verify(token)).toBeNull();
  });

  it('returns null without fetching when the team domain or aud is unset', async () => {
    const token = await signJwt(key, validClaims());
    expect(await verify(token, { ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: AUD })).toBeNull();
    expect(await verify(token, { ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: '' })).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns null when the JWKS cannot be fetched', async () => {
    fetchFn.mockImplementation(async () => new Response('down', { status: 503 }));
    expect(await verify(await signJwt(key, validClaims()))).toBeNull();
    fetchFn.mockRejectedValue(new Error('network'));
    expect(await verify(await signJwt(key, validClaims()))).toBeNull();
  });
});
