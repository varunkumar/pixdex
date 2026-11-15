// Cloudflare Turnstile server-side validation (siteverify). Used by the public enroll endpoint.
// Fails closed: anything other than a clear `success: true` from siteverify is a rejection.

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Turnstile tokens are at most 2048 characters (Cloudflare docs); anything longer is not a token.
export const MAX_TOKEN_LENGTH = 2048;

// A hung siteverify must not hang the enroll request.
const TIMEOUT_MS = 5000;

/**
 * True only when siteverify confirms the token. False, without any network call, for a missing or
 * blank secret and a missing, empty, non-string or oversized token; false for a non-2xx answer, a
 * network error or timeout, a body that is not JSON, or `success !== true`. One subrequest per call.
 */
export async function verifyTurnstile(token: unknown, secret: string | undefined, ip: string | null): Promise<boolean> {
  if (!secret?.trim()) return false;
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return false;

  const form = new URLSearchParams({ secret, response: token });
  if (ip) form.set('remoteip', ip);

  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const outcome: unknown = await response.json();
    return typeof outcome === 'object' && outcome !== null && (outcome as { success?: unknown }).success === true;
  } catch {
    return false;
  }
}
