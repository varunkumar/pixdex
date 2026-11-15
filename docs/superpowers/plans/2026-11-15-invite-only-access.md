# Invite-only access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PixdeX invite-only: a public enroll page collects access requests, the owner approves or revokes them on an admin page, and approval edits a Cloudflare Access group through the API.

**Architecture:** Cloudflare Access (group `pixdex-approved`) stays the only gate, so strangers are rejected at the edge. Requests live in a D1 table `access_requests`. A Function-rendered static HTML page plus `POST /api/enroll` (Turnstile checked) are the only public surface; the Worker applies an IP-keyed rate limit and a pending cap. Admin routes in the Worker (admin email only) call the Cloudflare API on approve and revoke.

**Tech Stack:** Cloudflare Pages Functions, Hono Worker (D1, Rate Limiting binding), Turnstile, Cloudflare Access API, React 19 + Mantine, vitest (workers pool for `worker/`).

**Spec:** `docs/superpowers/specs/2026-11-14-invite-only-access-design.md`

## Global Constraints

- Worker imports zod only as `import * as z from 'zod/mini'` (never `'zod'`); `z.flattenError(err)`.
- New D1 change = new numbered migration `worker/migrations/0019_access_requests.sql`, additive, mirrored in `worker/migrations/index.ts` (tests apply that mirror).
- Emails are stored lowercase and the database refuses anything else (triggers, like 0016); queries never wrap emails in `lower()`.
- `/ingest/*` stays out of the Pages proxy allowlist. No secret gets a `VITE_` prefix. `CF_API_TOKEN` is a Worker secret only.
- Admin routes answer 404 (not 403) to non-admins. The enroll response is identical for new, known, denied, approved and queue-full cases.
- Pending cap 200; note max 200 characters; enroll rate 5 per minute per IP; enroll is a silent no-op for any existing email.
- Status values: `pending`, `approved`, `denied`, `revoked`. Transitions: approve from `pending|denied|revoked`; deny from `pending`; revoke from `approved`. The admin email is never revocable.
- Group rewrite touches only email entries of the include list and preserves every other rule; one retry on a conflict.
- Revoke removes the email from the group AND revokes its Access sessions; if either Cloudflare call fails the row keeps its status.
- No em dashes in any text, code comment or doc.
- Every task states its Worker CPU and D1 cost; a pre-commit hook runs the touched suites (never bypass it).
- Update `README.md`, `AGENTS.md`, and `docs/` in the same change (Task 9).

## Review Focus

- Email `"  Foo@Example.COM "` enrolled twice (different case or spaces): one row, lowercased, same response both times (Task 4).
- Malformed or non-JSON body, missing email, 201-character note, 255+ character email: 400 from the Function, never a 500 (Tasks 4 and 6).
- Approve when the Cloudflare API fails: row stays `pending`, admin gets an error, retry works (Task 5).
- Approving, revoking or denying an id that does not exist or a row in the wrong state: 404 / 409, no Cloudflare call (Task 5).
- Revoking or denying the admin's own email: refused, group untouched (Task 5).
- Missing or failed Turnstile token: 403 and no Worker call; a Turnstile outage must not become an open door (Task 6).
- Non-admin signed-in user calling admin routes or loading `/admin/access`: 404 / no nav entry (Tasks 5 and 7).

---

### Task 1: Migration 0019 `access_requests`

**Files:**
- Create: `worker/migrations/0019_access_requests.sql`
- Modify: `worker/migrations/index.ts` (mirror, after the `0018_known_people.sql` mirror near line 215)
- Test: `worker/test/schema.test.ts` (add cases)

**Interfaces:**
- Produces: table `access_requests (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, note TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','revoked')), created_at TEXT NOT NULL, decided_at TEXT)`; index `idx_access_requests_status_created ON access_requests (status, created_at)`; triggers `access_requests_email_lower_bi` and `access_requests_email_lower_bu` (abort when `email <> lower(email)`, message `'emails on access_requests must be lowercase'`).

- [ ] **Step 1: Write failing tests** in `worker/test/schema.test.ts`: `it('rejects a non-lowercase access_requests email')` (INSERT with `'Foo@x.com'` throws /lowercase/), `it('rejects an unknown access_requests status')` (CHECK fails), `it('access_requests status listing uses idx_access_requests_status_created')` (`EXPLAIN QUERY PLAN SELECT id FROM access_requests WHERE status = 'pending' ORDER BY created_at DESC LIMIT 200` detail contains the index name).
- [ ] **Step 2: Run** `cd worker && npx vitest run test/schema.test.ts`. Expected: FAIL (no such table).
- [ ] **Step 3: Write the migration SQL** exactly as in Interfaces, using `IF NOT EXISTS` like 0016/0017, and add the same statements to the mirror in `index.ts` following how 0018 is mirrored.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(worker): access_requests table (migration 0019)`.

D1 cost: schema only. New writes are Task 4 and Task 5.

### Task 2: Admin identity, proxy-token middleware, `/me` admin flag

**Files:**
- Modify: `worker/src/types.ts` (Env), `worker/src/auth.ts`, `worker/src/routes/shares.ts` (`meRoute`), `worker/wrangler.toml` (rate limit binding, Task 4), test-binding file where `READ_TOKEN` is provided for tests
- Create: `worker/src/admin.ts`
- Test: `worker/test/admin.test.ts`

**Interfaces:**
- Produces in `types.ts` `Env`: `ADMIN_EMAIL: string; CF_API_TOKEN: string; CF_ACCOUNT_ID: string; CF_ACCESS_GROUP_ID: string; ENROLL_LIMITER?: RateLimit;`
- Produces `admin.ts`: `isAdmin(c: Context<{ Bindings: Env }>): boolean` (viewer email non-empty and equal to trimmed, lowercased `ADMIN_EMAIL`); `requireAdmin(c, next)` middleware that answers `c.text('Not Found', 404)` when not admin.
- Produces `auth.ts`: `requireProxyToken(c, next)`: bearer `READ_TOKEN` only (401 otherwise), does NOT require `X-Viewer-Email`.
- Changes `meRoute` to return `{ email: string; admin: boolean }`. Still no D1.

- [ ] **Step 1: Write failing tests** in `admin.test.ts`: `/me` returns `admin: true` for the admin email in any letter case and `admin: false` for another; `requireAdmin` on a temporary route returns 404 for a non-admin and passes for the admin; `requireProxyToken` returns 401 with a wrong or missing bearer and 200 with the right bearer and no viewer header.
- [ ] **Step 2: Run** `cd worker && npx vitest run test/admin.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the Env fields, `admin.ts`, `requireProxyToken`, and the `meRoute` change; give the test env `ADMIN_EMAIL=owner@example.com` (equals `OWNER_TEST_EMAIL`) and dummy `CF_*` values wherever `READ_TOKEN` is provided.
- [ ] **Step 4: Run** `cd worker && npm test && npm run typecheck`. Expected: PASS (existing `/me` tests updated for the new field).
- [ ] **Step 5: Commit** `feat(worker): admin identity helper, bearer-only proxy auth, /me admin flag`.

Cost: CPU constant, one env read. D1: none.

### Task 3: Cloudflare Access API client

**Files:**
- Create: `worker/src/cf/accessApi.ts`
- Test: `worker/test/access-api.test.ts` (stub `globalThis.fetch` with `vi.stubGlobal`)

**Interfaces:**
- Produces: `interface AccessApiConfig { token: string; accountId: string; groupId: string }`; `accessApiConfig(env: Env): AccessApiConfig`; `class AccessApiError extends Error { status: number }`; `addGroupEmail(cfg, email: string): Promise<void>`; `removeGroupEmail(cfg, email: string): Promise<void>`; `revokeUserSessions(cfg, email: string): Promise<void>`.
- Base URL `https://api.cloudflare.com/client/v4/accounts/{accountId}`. Group: `GET` then `PUT /access/groups/{groupId}`. Sessions: `POST /access/organizations/revoke_user` with `{ email }` (builder: confirm the endpoint and the narrowest token permission in Cloudflare's current docs and note it in `docs/development.md`).

- [ ] **Step 1: Write failing tests**: (a) `addGroupEmail` GETs the group, then PUTs a body whose `include` has the new `{ email: { email } }` entry AND leaves an existing `exclude`, `require` and a non-email include (for example `{ everyone: {} }`) byte-for-byte as returned; (b) adding an email already present issues no PUT; (c) `removeGroupEmail` removes only that email entry and is a no-op (no PUT) when absent; (d) the PUT answering a conflict status retries once (re-GET then PUT) and a second failure throws `AccessApiError`; (e) a non-2xx or `success: false` GET throws `AccessApiError` carrying the HTTP status; (f) `revokeUserSessions` POSTs `{ email }` and throws on failure; every request carries `Authorization: Bearer <token>`; emails compared lowercase.
- [ ] **Step 2: Run** `cd worker && npx vitest run test/access-api.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the three functions plus `accessApiConfig` (throws a plain Error if any of the three values is blank).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(worker): Cloudflare Access group and session API client`.

Cost: none on the hot path; only called from admin routes (owner, rare).

### Task 4: `POST /enroll` (Worker)

**Files:**
- Create: `worker/src/routes/access-requests.ts` (this task adds `enrollRoute`; Task 5 adds the rest)
- Modify: `worker/src/index.ts`, `worker/wrangler.toml` (Rate Limiting binding `ENROLL_LIMITER`, 5 per 60 s; builder: confirm current wrangler syntax)
- Test: `worker/test/enroll.test.ts`; `worker/test/sharing-writes.test.ts` (registry exception)

**Interfaces:**
- Consumes: `requireProxyToken` (Task 2), table (Task 1).
- Produces: `enrollRoute(c): Promise<Response>`. Body `{ email: string; note?: string }`, validated with `zod/mini` (`trim`, `toLowerCase`, `email`, `maxLength(254)` for email; note `trim`, `maxLength(200)`). Client IP read from header `X-Client-IP` (sent by the Function). Always `202` with body `{ ok: true }` for any valid body, whether inserted, duplicate, rate-limited-by-cap or queue full. 400 only for an invalid body. When `env.ENROLL_LIMITER` is present and `.limit({ key: ip })` fails: `429`. Absent limiter = no limit (tests, local dev).
- Insert statement: `INSERT INTO access_requests (email, note, created_at) SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM access_requests WHERE status = 'pending') < 200 ON CONFLICT(email) DO NOTHING`.
- Route wiring: `app.use('/enroll', requireProxyToken); app.post('/enroll', enrollRoute);` (not `guardedWrite`).

- [ ] **Step 1: Write failing tests** in `enroll.test.ts`: new email inserts one `pending` row and answers `202 {ok:true}`; `"  Foo@Example.COM "` then `"foo@example.com"` leaves one row `foo@example.com` and identical responses; an `approved`, a `denied` and a `revoked` row each stay unchanged when re-enrolled and still answer the same body; with 200 pending rows a new email answers the same 202 and inserts nothing; invalid email, 201-char note, 255-char email, non-JSON body each answer 400; wrong bearer answers 401; a fake `ENROLL_LIMITER` returning `{success:false}` answers 429 and inserts nothing. In `sharing-writes.test.ts`, change the registry test to exempt exactly `POST /enroll` with a comment that it authorizes by proxy token, not by album or person.
- [ ] **Step 2: Run** `cd worker && npx vitest run test/enroll.test.ts test/sharing-writes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `enrollRoute` and wire it. Document in the function comment: D1 cost 1 count (indexed, at most 200 rows) plus at most 1 write; 0 writes for duplicate or full queue; CPU trivial.
- [ ] **Step 4: Run** `cd worker && npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(worker): public enroll route with pending cap and rate limit`.

### Task 5: Admin routes (list, approve, deny, revoke)

**Files:**
- Modify: `worker/src/routes/access-requests.ts`, `worker/src/index.ts`
- Test: `worker/test/access-admin.test.ts`

**Interfaces:**
- Consumes: `requireReadToken`, `requireAdmin` (Task 2), `addGroupEmail`, `removeGroupEmail`, `revokeUserSessions`, `accessApiConfig`, `AccessApiError` (Task 3).
- Produces: `type AccessRequestRow = { id: number; email: string; note: string | null; status: 'pending'|'approved'|'denied'|'revoked'; createdAt: string; decidedAt: string | null }`.
  - `listRequestsRoute`: `GET /admin/requests?status=<one status, optional>` returns `{ requests: AccessRequestRow[]; pendingCount: number; queueFull: boolean }`, newest first, `LIMIT 200`, `queueFull = pendingCount >= 200`.
  - `approveRoute`, `denyRoute`, `revokeRoute`: `POST /admin/requests/:id/approve|deny|revoke` return `{ request: AccessRequestRow }`. 404 unknown id; 409 wrong source status; 400 when the target email equals `ADMIN_EMAIL` for deny or revoke; 502 `{ error }` when a Cloudflare call fails (row unchanged). Order: read row, check status, Cloudflare call(s), then `UPDATE ... WHERE id = ? AND status IN (...)`. Revoke calls `removeGroupEmail` then `revokeUserSessions`.
- Wiring: `app.use('/admin/*', requireReadToken, requireAdmin)`; each write registered with `guardedWrite('POST', '/admin/requests/:id/approve', ...)` etc.

- [ ] **Step 1: Write failing tests** (fetch stubbed for Cloudflare calls): non-admin gets 404 on all four routes and no Cloudflare call; list returns newest first, filters by status, `pendingCount` and `queueFull` at 199 and 200 pending; approve from `pending`, `denied`, `revoked` adds the email and sets `approved` with `decidedAt`; approve of an `approved` row answers 409; deny only from `pending` (409 otherwise) and makes no Cloudflare call; revoke only from `approved`, removes from the group and revokes sessions, sets `revoked`; revoke or deny of the admin email answers 400 and calls nothing; Cloudflare failure on approve leaves `pending` and answers 502, a following successful retry approves; failure on the session revoke leaves `approved`; unknown id 404.
- [ ] **Step 2: Run** `cd worker && npx vitest run test/access-admin.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the four handlers and wiring; include D1 cost in each handler comment (list: 2 statements in one `batch`, at most 200 rows, indexed, no OFFSET; actions: 1 read, 1 write, plus 2 to 3 Cloudflare API calls).
- [ ] **Step 4: Run** `cd worker && npm test && npm run typecheck`. Expected: PASS (including the `guardedWrites` registry test).
- [ ] **Step 5: Commit** `feat(worker): admin routes to list, approve, deny and revoke access requests`.

### Task 6: Pages Function (enroll page, `/api/enroll`, admin allowlists)

**Files:**
- Create: `functions/enroll.ts` (GET, self-contained HTML), `functions/api/enroll.ts` (POST), `functions/_lib/turnstile.ts`
- Modify: `functions/api/[[path]].ts` (allowlists), `test/functions/` or `functions/api/` tests
- Test: `functions/api/enroll.test.ts`, extend `functions/api/proxy.test.ts`

**Interfaces:**
- Produces `turnstile.ts`: `verifyTurnstile(token: unknown, secret: string | undefined, ip: string | null): Promise<boolean>`: POSTs `secret`, `response`, `remoteip` to `https://challenges.cloudflare.com/turnstile/v0/siteverify`; returns false for a missing secret, missing token, non-2xx, a network error, or `success !== true` (fail closed).
- Produces `functions/enroll.ts`: `onRequestGet({ env })` returns an HTML page with inline CSS and script only (no `/assets/*`, no React), the Turnstile widget using `env.TURNSTILE_SITE_KEY`, an email field, a note field (maxlength 200), and an identical "Request received" message on any 202. `Cache-Control: no-store`.
- Produces `functions/api/enroll.ts`: `onRequestPost({ request, env })`: parse JSON (400 on failure), minimal shape check (string email, optional string note, 400 otherwise), `verifyTurnstile` (403 on false, no Worker call), then `fetch(WORKER_URL + '/enroll')` with `Authorization: Bearer READ_TOKEN`, `Content-Type: application/json`, `X-Client-IP: CF-Connecting-IP`; relay the Worker status (202, 400, 429) with `Cache-Control: no-store` and `set-cookie` removed; 502 on a fetch error. Skips the Access JWT check.
- Env additions in the Function `Env` interfaces: `TURNSTILE_SECRET?`, `TURNSTILE_SITE_KEY?`.
- `[[path]].ts` changes: GET allowlist adds `/^admin\/requests$/`; POST allowlist adds `/^admin\/requests\/[^/]+\/(approve|deny|revoke)$/`. The existing Access JWT check still runs for these (no bypass).

- [ ] **Step 1: Write failing tests**: `enroll.test.ts` covers missing token 403 with zero Worker calls, Turnstile network error 403 with zero Worker calls, Turnstile success forwards with the bearer, `X-Client-IP` and the JSON body, Worker 429 and 400 relayed, malformed JSON 400, no Access JWT needed, `GET /enroll` HTML contains the site key and no `/assets/` reference. `proxy.test.ts` adds: `admin/requests` GET and the three POSTs forward with the verified viewer email and 401 without a JWT.
- [ ] **Step 2: Run** `npm test -- functions` (root vitest). Expected: FAIL.
- [ ] **Step 3: Implement** the files above.
- [ ] **Step 4: Run** `npm test -- functions test/functions` and `npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(functions): public enroll page and endpoint with Turnstile, admin proxy routes`.

Cost: Function-side only (one Turnstile subrequest per enroll). No Worker CPU beyond Task 4.

### Task 7: Admin page and nav (frontend)

**Files:**
- Create: `src/components/AdminAccess.tsx`, `src/components/__tests__/AdminAccess.test.tsx`
- Modify: `src/types/api.ts` (`MeResponse.admin: boolean`, `AccessRequest`, `AccessRequestsResponse`), `src/services/api/WorkerApiClient.ts`, `src/hooks/useMe.ts`, `src/components/Layout.tsx`, `src/App.tsx`, `dev/mockApi.ts`, `src/components/__tests__/Layout.test.tsx`

**Interfaces:**
- Produces: `useMe()` returns `{ email: string | null; admin: boolean; loading: boolean }`.
- Produces client methods: `listAccessRequests(status?: AccessRequest['status']): Promise<AccessRequestsResponse>` (`GET /admin/requests`), `decideAccessRequest(id: number, action: 'approve' | 'deny' | 'revoke'): Promise<AccessRequest>` (`POST /admin/requests/:id/<action>`).
- Produces `AdminAccess` at route `/admin/access`: tabs Pending, Approved, Denied, Revoked; rows show email, note, requested date; buttons per tab (Pending: Approve, Deny; Approved: Revoke; Denied and Revoked: Approve); buttons disabled while any decision call is in flight; a "pending queue is full" `Alert` when `queueFull`; shows an error notification on a 502; renders nothing (not found message) when `!admin`.
- Layout adds an "Access" nav link to `/admin/access` only when `admin` (hidden, never disabled), in both the header and the drawer.

- [ ] **Step 1: Write failing tests**: Layout hides the link for a non-admin and shows it for admin; `AdminAccess` lists pending rows, Approve calls `decideAccessRequest(id, 'approve')` and the row leaves the list after refetch, shows the queue-full alert, shows the not-found message for a non-admin, disables buttons during a pending call, shows an error notification when the call rejects.
- [ ] **Step 2: Run** `npm test -- AdminAccess Layout`. Expected: FAIL.
- [ ] **Step 3: Implement** the page with React Query (`['access-requests', status]`, invalidate on success) in the style of `ShareAlbumModal.tsx`; extend `dev/mockApi.ts` with `/me` `admin: true` and stub admin endpoints so `PIXDEX_MOCK=1 npm run dev` shows the page.
- [ ] **Step 4: Run** `npm test && npm run lint && npm run build`. Expected: PASS.
- [ ] **Step 5: Verify in a browser** with `PIXDEX_MOCK=1 npm run dev`: open `/admin/access`, approve a pending row, check light and dark modes and a phone width.
- [ ] **Step 6: Commit** `feat: admin access page and nav entry`.

Cost: frontend only; one `GET /admin/requests` per tab view, admin only.

### Task 8: Rollout seed script

**Files:**
- Create: `worker/scripts/seed-access.mjs`, `worker/scripts/seed-access-lib.mjs`
- Modify: `worker/package.json` (`"seed-access": "node scripts/seed-access.mjs"`)
- Test: `worker/test/seed-access.test.ts` (style of `backfill-owner.test.ts`)

**Interfaces:**
- Produces lib: `planSeed(rows: { owner: string | null; shared: string | null }[], adminEmail: string): { emails: string[]; sql: string }`: collects distinct lowercase emails from `owner` and the JSON arrays in `shared`, plus the admin; throws an Error naming the addresses when the distinct total is not exactly 2; `sql` is one `INSERT OR IGNORE INTO access_requests (email, status, created_at, decided_at) VALUES ...` with status `approved`.
- Produces CLI: `npm run seed-access [-- --local] [-- --dry-run]`: reads `ADMIN_EMAIL` from the environment or `../agent/.env` `OWNER_EMAIL`; queries `albums` through `wrangler d1 execute --json`; prints the emails and the SQL; with `--dry-run` stops there; otherwise executes the SQL. Idempotent. It does not touch Cloudflare (the group is filled by hand once, step in Task 9 docs).

- [ ] **Step 1: Write failing tests** for `planSeed`: two addresses ok and lowercased and de-duplicated; a third address throws naming it; malformed `shared` JSON throws; admin missing from the data is still included.
- [ ] **Step 2: Run** `cd worker && npx vitest run test/seed-access.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** lib and CLI (arg parsing like `backfill-owner-args.mjs`).
- [ ] **Step 4: Run** `cd worker && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(worker): seed-access rollout script`.

### Task 9: Docs, rollout guide, graph

**Files:**
- Modify: `README.md`, `AGENTS.md`, `docs/architecture.md`, `docs/development.md`

- [ ] **Step 1: Update `AGENTS.md`**: add the invite-only model (Access group is the gate; `access_requests`; routes `POST /enroll` bearer-only exception, `GET /admin/requests`, `POST /admin/requests/:id/approve|deny|revoke`; `ADMIN_EMAIL`, `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_ACCESS_GROUP_ID` Worker secrets, `TURNSTILE_SECRET` and `TURNSTILE_SITE_KEY` Pages variables, `ENROLL_LIMITER` binding); change the `useMe` sentence to `{ email, admin, loading }`; add the new Function allowlist entries and the public `/enroll` and `/api/enroll` paths; note the `guardedWrites` exception.
- [ ] **Step 2: Update `docs/development.md`**: replace rollout step 5 ("allow any Google account") with the invite-only rollout from the spec (create group and add the two emails, bypass app for `/enroll` and `/api/enroll`, set secrets and variables, merge, run `npm run seed-access`, then switch the policy to the group, then verify with a non-approved account); add the Cloudflare API token permission note and how to measure the unmeasurable parts (`wrangler tail`, Access logs, end-to-end check). Update `docs/architecture.md` and `README.md` setup sections.
- [ ] **Step 3: Run everything**: `npm test && npm run lint && npm run build`, `cd worker && npm test && npm run typecheck`, `cd agent && npm test && npm run typecheck`. Expected: all PASS.
- [ ] **Step 4: Run** `graphify update .`.
- [ ] **Step 5: Commit** `docs: invite-only access model, rollout and config`.

---

## Self-review

- **Spec coverage:** edge gate and group (Tasks 3, 5, 9); public enroll page and endpoint with Turnstile, rate limit, cap, no enumeration (Tasks 4, 6); admin routes and transitions (Task 5); admin page with four tabs and queue-full banner (Task 7); `/me` admin flag (Task 2); immediate revoke (Tasks 3, 5); seed of exactly two emails (Task 8); migration with lowercase triggers (Task 1); rollout order and docs (Task 9); performance stated per task. Left to the builder in the spec and decided here: rate limit lives in the Worker keyed by `X-Client-IP` (Pages bindings are not assumed), unlimited when the binding is absent.
- **Types:** `AccessRequestRow` (Worker) and `AccessRequest` (frontend) share the field names `id, email, note, status, createdAt, decidedAt`; route paths and the `admin` field match across Tasks 2, 5, 6, 7.
- **Performance summary:** browse hot path unchanged; enroll at most 1 indexed count (up to 200 rows) plus 1 write; admin list 2 statements, at most 200 rows; admin actions 1 read, 1 write, plus Cloudflare calls. Unmeasurable locally: Turnstile, Cloudflare Access API, Access bypass, rate-limit binding behaviour.
