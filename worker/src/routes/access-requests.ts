import type { Context } from 'hono';
import * as z from 'zod/mini';
import {
  AccessApiError,
  accessApiConfig,
  addGroupEmail,
  removeGroupEmail,
  revokeUserSessions,
  type AccessApiConfig,
} from '../cf/accessApi';
import { adminEmail } from '../admin';
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

// ---------------------------------------------------------------------------------------------
// Admin routes. Mounted behind requireReadToken + requireAdmin (non-admins get 404), so the
// handlers below never re-check identity. The note is user-supplied text returned as plain JSON
// data; nothing here builds HTML.

export type AccessRequestStatus = 'pending' | 'approved' | 'denied' | 'revoked';

export type AccessRequestRow = {
  id: number;
  email: string;
  note: string | null;
  status: AccessRequestStatus;
  createdAt: string;
  decidedAt: string | null;
};

type DbRow = {
  id: number;
  email: string;
  note: string | null;
  status: AccessRequestStatus;
  created_at: string;
  decided_at: string | null;
};

const STATUSES: readonly AccessRequestStatus[] = ['pending', 'approved', 'denied', 'revoked'];
const LIST_LIMIT = 200;
const COLUMNS = 'id, email, note, status, created_at, decided_at';

/** Filtered list: walks idx_access_requests_status_created backwards (status = ?), no sort, at most 200 rows. */
export const LIST_BY_STATUS_SQL = `SELECT ${COLUMNS} FROM access_requests WHERE status = ?
  ORDER BY created_at DESC, id DESC LIMIT ${LIST_LIMIT}`;
/**
 * Unfiltered list: walks the rowid (primary key) backwards and stops after 200 rows, no sort. id
 * order is time order because created_at is stamped at insert (enrollRoute) and INTEGER PRIMARY KEY
 * ids only grow. Ordering by created_at here would read every row plus a temp B-tree sort.
 */
export const LIST_ALL_SQL = `SELECT ${COLUMNS} FROM access_requests ORDER BY id DESC LIMIT ${LIST_LIMIT}`;
/** Covering index search on status = 'pending'; at most 200 index entries (enroll caps the queue). */
export const PENDING_COUNT_SQL = `SELECT COUNT(*) AS n FROM access_requests WHERE status = 'pending'`;

const toRow = (r: DbRow): AccessRequestRow => ({
  id: r.id,
  email: r.email,
  note: r.note,
  status: r.status,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
});

/**
 * GET /admin/requests?status=<optional>: { requests, pendingCount, queueFull }, newest first.
 *
 * Cost: one DB.batch of 2 statements, 0 writes, no OFFSET, no COUNT over the whole table. Rows read:
 * at most 200 list rows (filtered: index range on idx_access_requests_status_created; unfiltered:
 * rowid walked backwards, LIMIT stops it) plus at most 200 covering-index entries for the pending
 * count. Worker CPU: mapping at most 200 small rows.
 */
export async function listRequestsRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const status = c.req.query('status');
  if (status !== undefined && !STATUSES.includes(status as AccessRequestStatus)) {
    return c.json({ error: 'Invalid status' }, 400);
  }
  const db = c.env.DB;
  const list = status === undefined ? db.prepare(LIST_ALL_SQL) : db.prepare(LIST_BY_STATUS_SQL).bind(status);
  const [rows, count] = await db.batch([list, db.prepare(PENDING_COUNT_SQL)]);
  const pendingCount = Number((count.results[0] as { n: number } | undefined)?.n ?? 0);
  return c.json({
    requests: (rows.results as DbRow[]).map(toRow),
    pendingCount,
    queueFull: pendingCount >= MAX_PENDING_REQUESTS,
  });
}

type Action = {
  from: readonly AccessRequestStatus[];
  to: AccessRequestStatus;
  /** Deny and revoke may not target the admin (that would lock the admin out). */
  refuseAdmin: boolean;
  /** Cloudflare call(s) made before D1 changes; undefined means none. */
  cloudflare?: (cfg: AccessApiConfig, email: string) => Promise<void>;
};

const APPROVE: Action = {
  from: ['pending', 'denied', 'revoked'],
  to: 'approved',
  refuseAdmin: false,
  cloudflare: (cfg, email) => addGroupEmail(cfg, email),
};
const DENY: Action = { from: ['pending'], to: 'denied', refuseAdmin: true };
const REVOKE: Action = {
  from: ['approved'],
  to: 'revoked',
  refuseAdmin: true,
  // Both calls are idempotent: if the session revoke fails the row stays approved and a retry is safe.
  cloudflare: async (cfg, email) => {
    await removeGroupEmail(cfg, email);
    await revokeUserSessions(cfg, email);
  },
};

const conflict = (c: Context<{ Bindings: Env }>) => c.json({ error: 'Request is not in a state that allows this' }, 409);

/**
 * Shared flow: read the row, check its status, Cloudflare call(s), then a status-guarded UPDATE
 * (a double click or race changes 0 rows and answers 409). A Cloudflare failure (API error, network
 * error or missing config) answers 502 with a generic message and leaves D1 unchanged; the token,
 * response bodies and stack traces never reach the response or the log.
 *
 * Cost: D1 1 primary-key read plus 1 primary-key write (RETURNING, so no re-read); 0 writes on any
 * 4xx or 502. Cloudflare subrequests: approve 2 (GET group, PUT group; 1 if already a member, 4 on
 * one conflict retry), deny 0, revoke 3 (GET group, PUT group, POST revoke_user; 2 if not a member).
 * Worker CPU: trivial, one group JSON round trip on approve and revoke.
 */
async function decide(c: Context<{ Bindings: Env }>, action: Action): Promise<Response> {
  const raw = c.req.param('id') ?? '';
  const id = /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(id)) return c.json({ error: 'Not found' }, 404);

  const db = c.env.DB;
  const row = await db.prepare(`SELECT ${COLUMNS} FROM access_requests WHERE id = ?`).bind(id).first<DbRow>();
  if (!row) return c.json({ error: 'Not found' }, 404);
  if (!action.from.includes(row.status)) return conflict(c);
  if (action.refuseAdmin && row.email === adminEmail(c.env)) {
    return c.json({ error: 'The admin email cannot be denied or revoked' }, 400);
  }

  if (action.cloudflare) {
    try {
      await action.cloudflare(accessApiConfig(c.env), row.email);
    } catch (err) {
      // Only the status is logged: never the error object, the token or a response body.
      console.error('Cloudflare Access call failed', err instanceof AccessApiError ? err.status : 'network or config');
      return c.json({ error: 'Cloudflare Access update failed, please retry' }, 502);
    }
  }

  const placeholders = action.from.map(() => '?').join(', ');
  const updated = await db
    .prepare(
      `UPDATE access_requests SET status = ?, decided_at = ? WHERE id = ? AND status IN (${placeholders})
       RETURNING ${COLUMNS}`
    )
    .bind(action.to, new Date().toISOString(), id, ...action.from)
    .first<DbRow>();
  if (!updated) return conflict(c);
  return c.json({ request: toRow(updated) });
}

/** POST /admin/requests/:id/approve: from pending, denied or revoked; adds the email to the Access group. Cost: see decide. */
export const approveRoute = (c: Context<{ Bindings: Env }>) => decide(c, APPROVE);
/** POST /admin/requests/:id/deny: from pending only; no Cloudflare call. Cost: see decide. */
export const denyRoute = (c: Context<{ Bindings: Env }>) => decide(c, DENY);
/** POST /admin/requests/:id/revoke: from approved only; removes from the group then revokes sessions. Cost: see decide. */
export const revokeRoute = (c: Context<{ Bindings: Env }>) => decide(c, REVOKE);
