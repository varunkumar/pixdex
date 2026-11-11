// Test-only helpers for Cloudflare Access JWTs. Keys are generated at test time
// with WebCrypto; no private key is ever committed.

export const TEAM_DOMAIN = 'team.cloudflareaccess.com';
export const AUD = 'aud-tag-123';
export const CERTS_URL = `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`;

export interface TestKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JsonWebKey & { kid: string };
}

export async function makeKey(kid: string): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { kid, privateKey: pair.privateKey, publicJwk: { ...jwk, kid, alg: 'RS256', use: 'sig' } };
}

function b64url(data: string | Uint8Array): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function signJwt(
  key: TestKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'RS256', kid: key.kid, typ: 'JWT' }
): Promise<string> {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

export function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    aud: [AUD],
    email: 'Friend@Example.com ',
    exp: now + 600,
    iat: now - 10,
    nbf: now - 10,
    iss: `https://${TEAM_DOMAIN}`,
    sub: 'user-1',
    ...overrides,
  };
}

export function certsResponse(keys: TestKey[]): Response {
  return new Response(JSON.stringify({ keys: keys.map((k) => k.publicJwk) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
