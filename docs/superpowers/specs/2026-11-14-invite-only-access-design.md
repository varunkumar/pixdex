# Invite-only access (enroll, approve, enforce)

Date: 2026-11-14. Status: draft for approval. Part A of two; part B (per-user daily limits) is a separate design that builds on this one.

## Intent and why

Album sharing (2026-11-10) made PixdeX multi-user, and the rollout told the owner to open the Cloudflare Access policy to
"any Google account". Now anyone with a Google account can pass Access and invoke the Pages Function and Worker. They see
nothing (every read is scoped), but each call still consumes Cloudflare resources the owner pays for or is capped on.

The owner wants PixdeX to be invite-only, with one twist: anyone may ask. A public enroll page collects requests, the owner
reviews them on an admin page and grants or refuses access, and granting is done by the app through the Cloudflare API, not by
hand-editing the Zero Trust dashboard.

## Goals

- Uninvited people are rejected at the Cloudflare edge by Access, before the Function or Worker runs (zero invocations).
- Anyone can submit an access request on a public page.
- Only the owner can see requests and approve, deny or revoke. Approval takes effect without a dashboard visit.
- The public surface (the enroll page and its endpoint) is small, cheap and hard to abuse.

## Non-goals

- Anyone but the owner inviting people. Album owners sharing an album does NOT grant login (they can only share with people
  who already have access).
- Per-user daily limits (part B).
- Emailing the owner about new requests, or emailing the requester a decision (the owner checks the admin page; can come later).
- An app-level allowlist check in the Function or Worker. Access is the one gate; a second check would cost a D1 read per call.
- Roles beyond owner (admin) and approved user.

## Anti-goals (failures even if it technically works)

- The enroll endpoint becomes a free spam or enumeration channel (it must answer identically whether or not an email is
  already known, approved or denied).
- The Cloudflare API token can do more than manage Access groups and revoke Access user sessions (nothing else: no policy
  edits, no apps, no other products).
- Strangers still reach the Function because an Access bypass was too wide.
- The owner locks themselves out while switching the policy.

## Constraints

- Pushing to `main` deploys both Pages and the Worker; there is no CI gate. Migrations are additive.
- Worker free plan: 10 ms CPU per invocation. D1 free plan: row and write budgets. Both are hot-path sensitive.
- `/ingest/*` stays out of the Pages proxy allowlist. Secrets never get a `VITE_` prefix.
- The Worker today never reads `OWNER_EMAIL`. The admin identity is a new, narrower setting (`ADMIN_EMAIL`), see Decisions.
- The Access policy, group and bypass live in the Cloudflare dashboard and API, so they cannot be tested locally.

## Approaches considered

1. **Access stays the only gate; approval edits its group through the API (chosen).** Public enroll page on an Access bypass,
   requests in D1, admin page approves by adding the email to an Access group the PixdeX policy includes. Strangers never pass
   the edge. Cost: an API token (Access groups: edit) as a secret, and one-time dashboard setup.
2. **Access open to anyone, allowlist in D1.** Simplest and the email is verified at login, but every stranger still invokes
   the Function and costs a D1 check. Rejected: it is the problem being solved.
3. **Two Access apps (open enroll app, locked PixdeX app), list synced by API.** Verifies the email at enroll, but needs two
   hostnames and every stranger who logs in to the enroll app may count against the Zero Trust free-plan user cap (believed to
   be about 50; check). Rejected for the cap risk and the extra setup.

The owner picked approach 1.

## Design

### Pieces

- **Access (dashboard, one time):** an Access group `pixdex-approved` (include: explicit emails). The PixdeX Access application's
  policy becomes "Allow: group pixdex-approved" (replaces "any Google account"). A second Access application with a Bypass
  policy covers exactly the paths `/enroll` and `/api/enroll`.
- **Enroll page:** `functions/enroll.ts` returns a self-contained HTML page (inline CSS and script, Turnstile widget, no React
  bundle). It must not depend on `/assets/*`, because those stay behind Access. Fields: email, optional note (max 200
  characters). On submit it posts JSON to `/api/enroll` and always shows the same "Request received. If approved you will be
  able to sign in with this email" message.
- **`POST /api/enroll` (Function, public):** skips the Access JWT check for this path only. Order: parse and validate (email
  shape, lowercase and trim, length caps) then verify the Turnstile token with Cloudflare `siteverify` (secret
  `TURNSTILE_SECRET`, Pages) then apply an IP-keyed Rate Limiting binding (about 5 per minute) then forward to the Worker.
  Always responds 202 with the same body for any valid-looking submission, including known emails.
- **Worker `POST /enroll`:** guarded by a new bearer-only middleware `requireProxyToken` (READ_TOKEN, no `X-Viewer-Email`, since
  the requester is unauthenticated). One statement:
  `INSERT INTO access_requests (...) SELECT ... WHERE (SELECT COUNT(*) FROM access_requests WHERE status='pending') < 200
  ON CONFLICT(email) DO NOTHING`. A full queue or an existing row (any status) is silently a no-op, so a denied or approved
  email cannot be probed. Not in `guardedWrites` (it authorizes by token, not by album or person; the test list must treat it
  as an explicit exception with a comment).
- **Admin routes (Worker, via the Function's GET and POST allowlists, behind Access like everything else):**
  `GET /admin/requests?status=` (bounded, newest first, max 200 rows), `POST /admin/requests/:id/approve`, `/deny`, `/revoke`.
  Every admin route requires viewer email equal to `ADMIN_EMAIL` (lowercased) and answers 404 otherwise, so non-admins cannot
  tell the routes exist.
- **Approve:** the Worker calls the Cloudflare API: GET the group, add the email to its include list (skip if present), PUT it
  back, then set `status='approved'`, `decided_at`. If the API call fails, D1 is not changed and the admin sees the error
  (the row stays pending; safe to retry). **Revoke** is immediate (owner's decision): it removes the email from the group AND calls the Access "revoke user sessions"
  API for that email, so an open session stops working at once, then sets `revoked`. If either Cloudflare call fails the row
  stays `approved` and the admin sees the error (both calls are idempotent, so retry is safe). **Deny** only sets `denied` (the email
  was never in the group). The admin email is always in the group and cannot be revoked.
- **Admin page:** SPA route `/admin/access`, nav entry and route rendered only when `GET /me` says the caller is admin
  (`/me` gains `admin: boolean`, computed from `ADMIN_EMAIL`, still no D1). Shows pending, approved and denied tabs with
  email, note, requested date and the action buttons. Hidden, never disabled, for non-admins (the existing gating rule).

### Data

Migration `0019_access_requests.sql` (additive):
`access_requests (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, note TEXT, status TEXT NOT NULL DEFAULT 'pending'
CHECK (status IN ('pending','approved','denied','revoked')), created_at TEXT NOT NULL, decided_at TEXT)`, an index on
`(status, created_at)`, and the same lowercase-email trigger convention as migration 0016.

### Configuration

- Worker secrets: `ADMIN_EMAIL`, `CF_API_TOKEN` (Access permissions needed for group edit and user-session revoke, limited to the one account; the builder
  verifies the narrowest permission that covers both, which is likely "Access: Organizations, Identity Providers, and Groups"), `CF_ACCOUNT_ID`,
  `CF_ACCESS_GROUP_ID`.
- Pages variables: `TURNSTILE_SECRET`, `TURNSTILE_SITE_KEY` (public, rendered into the enroll page).
- Rate Limiting binding for the enroll route (see "Left to the builder" for where it lives).

### Rollout (order matters, to avoid lockout)

1. Create the Access group and put in it exactly two people, per the owner: the admin and the one person albums are shared with
   today. The seed script (like `backfill-owner`, dry-run first) reads the distinct emails from `albums.owner_email` and
   `albums.shared_with`, prints them, and refuses to continue if the list is not those two (a third address means stop and ask),
   then writes `approved` rows. `ADMIN_EMAIL` is the same address as the agent's `OWNER_EMAIL` (my assumption from "add me").
2. Add the bypass application for `/enroll` and `/api/enroll`.
3. Set the secrets and variables, merge (migration 0019 applies before the Worker goes live).
4. Only then switch the PixdeX Access policy from "any Google account" to the group. Update `docs/development.md` rollout
   step 5, which currently says to allow any Google account.
5. Verify with a non-approved Google account (blocked at the edge), an enroll, an approve, and a revoke.

### Performance review (mandatory)

- Enroll (Function then Worker): Worker CPU trivial (one INSERT, no loops or JSON of size). D1: at most 1 indexed count over
  pending rows (cap 200, `idx_access_requests_status_created`) plus 1 write; a duplicate or full queue writes 0. The Turnstile
  `siteverify` and the rate-limit check are Function-side (subrequest and binding, not Worker CPU).
- Admin list: 1 read, at most 200 rows, indexed, no OFFSET, no COUNT(*).
- Approve: 1 Cloudflare API GET, 1 PUT, 1 D1 write. Revoke: the same plus 1 session-revoke call. Rare, owner-only.
- `/me`: no D1 change (reads one env var).
- Browse hot path: unchanged. Net effect is a cost reduction: strangers are stopped at the edge.
- Cannot be measured locally: Turnstile, the Cloudflare API, Access bypass behaviour, the rate-limit binding. Measure with
  `wrangler tail`, the Access logs, and an end-to-end check on the deployed site.

### Security notes

- The requester's email is unverified at enroll. Access's one-time PIN or Google login proves ownership at first sign-in, so a
  request for someone else's address can only grant that real person access (and the owner decides anyway).
- Revoking is immediate: the group removal blocks new sign-ins and the session-revoke call ends open sessions.
- The token has only the Access permissions for groups and session revocation, so a leaked token cannot read photos (verify the
  exact permission when creating the token). It can still add itself or others to the group, so it is as sensitive as the admin
  login: keep it a Worker secret only, never in Pages or the browser.
- Admin routes return 404 to non-admins. The enroll response never reveals whether an email is known.

## Decisions

- Chosen by the owner: approach 1; only the owner invites; the owner may maintain the explicit user list in Zero Trust.
- My calls (flagged for review): the self-contained HTML enroll page instead of a React route (the bundle sits behind Access);
  `ADMIN_EMAIL` as a Worker secret (a narrow exception to "the Worker never reads OWNER_EMAIL"); silent no-op for known emails;
  pending cap 200; note cap 200 characters; 5 per minute per IP; admin routes return 404; seeding the group from current sharees.

## Calls made after the builder check (mine, flagged for review)

- Status transitions (each admin route guards with `WHERE status IN (...)`): approve from `pending`, `denied` or `revoked`
  (reinstate); deny from `pending` only; revoke from `approved` only. Enroll never reopens a row, so a denied or revoked
  email stays silent; the owner reinstates from the admin page. The admin page has tabs Pending, Approved, Denied and Revoked.
- Group rewrite: change only the email entries of the include list; preserve every other include, exclude and require rule
  as found. One retry if the API reports a conflict. The admin page disables the action buttons while a call is in flight.
- Full queue: still a silent no-op for the requester (no enumeration), but the admin page shows a "pending queue is full"
  banner when 200 pending rows exist, so the owner knows to clear it.
- If the Rate Limiting binding is not available in Pages, the Worker applies it (one binding call per enroll, still trivial CPU).

## Left to the builder

- Where the Rate Limiting binding lives (Pages Function bindings may not support it; if not, apply it in the Worker keyed by
  the forwarded IP from `CF-Connecting-IP`).
- Exact Cloudflare API calls and payload shape for Access groups, error handling and retry.
- Whether pagination is needed beyond the 200-row bound, and the admin page layout (use Mantine like the rest of the SPA).
- Test plan: `worker/test` for the admin gate, the enroll no-op cases and the `guardedWrites` exception; Function tests for the
  public bypass path and Turnstile failure; frontend tests for the admin page gating.
- Docs to update in the same commit: `README.md`, `AGENTS.md` (including the `useMe` and Function allowlist descriptions),
  `docs/architecture.md`, `docs/development.md`.
