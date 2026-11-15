import type { Context } from 'hono';
import * as z from 'zod/mini';
import type { Env } from '../types';

/** Open pending requests at most; beyond this a new email is silently dropped. */
export const MAX_PENDING_REQUESTS = 200;

const enrollBody = z.object({
  email: z.string().check(z.trim(), z.toLowerCase(), z.maxLength(254), z.email()),
  note: z.optional(z.string().check(z.trim(), z.maxLength(200))),
});

/**
 * POST /enroll: public "request access" (the Function forwards it with the proxy bearer token and
 * the requester IP in X-Client-IP). Authorizes by proxy token only, not by album or person, so it is
 * the one write outside the guarded registry.
 *
 * Anti-enumeration: any valid body answers 202 {ok:true}, whether the email was new, already present
 * in any status, or the pending queue was full. 400 only for an invalid body, 429 only when the
 * rate limiter refuses. The limiter runs first, so every call from an IP counts (garbage included)
 * and an abuser pays no JSON parsing or D1 cost once limited; an invalid body never reaches D1.
 *
 * Cost: one statement. D1 reads: a COUNT over idx_access_requests_status_created (at most 200 rows)
 * plus one email key probe; writes: at most 1 row (0 for a duplicate or a full queue). Worker CPU is
 * trivial: no loops, no large JSON. An absent ENROLL_LIMITER (tests, local dev) means no limit.
 */
export async function enrollRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (c.env.ENROLL_LIMITER) {
    const key = c.req.header('X-Client-IP')?.trim() || 'unknown';
    const { success } = await c.env.ENROLL_LIMITER.limit({ key });
    if (!success) return c.json({ error: 'Too many requests' }, 429);
  }

  const parsed = enrollBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: z.flattenError(parsed.error) }, 400);

  await c.env.DB.prepare(
    `INSERT INTO access_requests (email, note, created_at)
     SELECT ?, ?, ?
     WHERE (SELECT COUNT(*) FROM access_requests WHERE status = 'pending') < ${MAX_PENDING_REQUESTS}
     ON CONFLICT(email) DO NOTHING`
  )
    .bind(parsed.data.email, parsed.data.note || null, new Date().toISOString())
    .run();

  return c.json({ ok: true }, 202);
}
