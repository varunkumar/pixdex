// Cloudflare Access JWT verification for the Pages Function. The Function trusts
// a user's email only after checking the Cf-Access-Jwt-Assertion token's RS256
// signature against the team's JWKS, its aud and its exp (and nbf when present).
// The plain Cf-Access-Authenticated-User-Email header is never trusted.

export interface AccessEnv {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

interface Jwks {
  domain: string;
  fetchedAt: number;
  keys: Map<string, CryptoKey>;
}

const JWKS_TTL_MS = 60 * 60 * 1000;
// An unknown kid triggers one refetch (key rotation), but at most once a minute,
// so a stream of tokens with made-up kids cannot turn into a JWKS fetch per request.
const REFETCH_COOLDOWN_MS = 60 * 1000;

let jwks: Jwks | null = null;

/** Test hook: forget the cached JWKS. */
export function resetJwksCache(): void {
  jwks = null;
}

function b64urlToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  try {
    const bin = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function parseJson(segment: string): Record<string, unknown> | null {
  const bytes = b64urlToBytes(segment);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function loadJwks(domain: string, fetchFn: typeof fetch): Promise<Jwks | null> {
  try {
    const response = await fetchFn(`https://${domain}/cdn-cgi/access/certs`);
    if (!response.ok) return null;
    const body = (await response.json()) as { keys?: unknown };
    if (!Array.isArray(body.keys)) return null;
    const keys = new Map<string, CryptoKey>();
    for (const jwk of body.keys as (JsonWebKey & { kid?: unknown })[]) {
      if (jwk?.kty !== 'RSA' || typeof jwk.kid !== 'string') continue;
      try {
        const { kty, n, e } = jwk;
        keys.set(
          jwk.kid,
          await crypto.subtle.importKey('jwk', { kty, n, e }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, [
            'verify',
          ])
        );
      } catch {
        // Skip keys that do not import; the rest of the set is still usable.
      }
    }
    return { domain, fetchedAt: Date.now(), keys };
  } catch {
    return null;
  }
}

async function keyFor(kid: string, domain: string, fetchFn: typeof fetch): Promise<CryptoKey | null> {
  const now = Date.now();
  if (!jwks || jwks.domain !== domain || now - jwks.fetchedAt >= JWKS_TTL_MS) {
    jwks = await loadJwks(domain, fetchFn);
  } else if (!jwks.keys.has(kid) && now - jwks.fetchedAt >= REFETCH_COOLDOWN_MS) {
    jwks = (await loadJwks(domain, fetchFn)) ?? jwks;
  }
  return jwks?.keys.get(kid) ?? null;
}

/**
 * Verifies a Cloudflare Access JWT and returns the lowercased, trimmed email
 * claim, or null for a missing, malformed, unsigned, wrongly signed, expired,
 * not-yet-valid or wrong-audience token, or when the Access config is unset.
 */
export async function verifyAccessJwt(
  token: string | null,
  env: AccessEnv,
  fetchFn: typeof fetch = fetch
): Promise<{ email: string } | null> {
  const domain = env.ACCESS_TEAM_DOMAIN?.trim();
  const aud = env.ACCESS_AUD?.trim();
  if (!token || !domain || !aud) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = parseJson(headerPart);
  const payload = parseJson(payloadPart);
  const signature = b64urlToBytes(signaturePart);
  if (!header || !payload || !signature || signature.length === 0) return null;
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;

  // Cheap claim checks first, so a stale or foreign token costs no crypto.
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
  if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || payload.nbf > now)) return null;
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(aud)) return null;
  if (typeof payload.email !== 'string') return null;
  const email = payload.email.trim().toLowerCase();
  if (!email) return null;

  const key = await keyFor(header.kid, domain, fetchFn);
  if (!key) return null;
  const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  try {
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed);
    return ok ? { email } : null;
  } catch {
    return null;
  }
}
