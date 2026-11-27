# Access, sharing, authorization and Pages Functions

Agent notes. Read this file before you change this area. Update it with each change.
The core rules are in [`AGENTS.md`](../../AGENTS.md). Paths are relative to the repository root.

- Frontend gating (hidden, never disabled): photo review controls and the photo's face-naming controls use
  `photo.canEdit` (the user owns the album); album cover, Reposition and Share use the album's `role === 'owner'` (the album page reads it from
  its `album-summary` query); rename, delete, matching and covers on a person use that person's `canEdit` (the user created it).
  `useMe()` (`src/hooks/useMe.ts`, `GET /me`, `staleTime: Infinity`) returns only `{ email, admin, loading }`. The admin page `src/components/AdminAccess.tsx` (route `/admin/access`, "Access" nav link in `Layout.tsx`, both hidden unless `admin`) lists access requests per status tab (`GET /admin/requests?status=`, query key `['access-requests', status]`, no polling, only enabled for an admin) and approves, denies or revokes through `decideAccessRequest` (POST with a JSON body `{}`; one decision at a time, all buttons disabled while one is pending; the note is plain text only). The share dialog is
  `src/components/ShareAlbumModal.tsx` (a people list: owner, then sharees with remove buttons). Avatars are drawn locally from the
  email (`UserAvatar.tsx`, helpers in `avatarUtils.ts`); never call an external avatar service. `GET /albums` gives a viewer the
  album's `ownerEmail` (never the other sharees); the owner gets `sharedWith`.
- Access model: there is no default owner and no special user. `albums.owner_email` is the album owner; `albums.shared_with` is a
  JSON array of lowercase emails or NULL. An album with a NULL owner belongs to nobody and is invisible to everyone until the
  one-time backfill (`cd worker && npm run backfill-owner`) stamps it; photos with no album are likewise visible to nobody.
  Emails are always stored lowercase and compared exactly (triggers in migration 0016 abort any other write), so queries never
  wrap them in lower(). A user sees their own albums and albums shared with them. Role on an album: owner, viewer, or none
  (`albumRole`). Invisible is 404, a viewer's write is 403. There are no fast paths: every read is always scoped
  (`scopeFor`, `photoAccess`, `canEditFor`), so each request pays the scope (a thumbnail is one D1 read). Worker routes:
  `GET /me` (`{ email, admin }`, no D1), `PUT /albums/shares` (owner only, max 50 emails), `GET /access/photo/:id` (204 or 404,
  called by the Function with READ_TOKEN for every original, the album owner's included). Every Worker read and write needs
  `X-Viewer-Email` as well as READ_TOKEN (else 401). The Worker never reads `OWNER_EMAIL`: it lives only in `agent/.env` (sent as
  `ownerEmail` on `POST /ingest/photo` and as the viewer on originals and `index-status` reads). Pages needs `ACCESS_TEAM_DOMAIN` and
  `ACCESS_AUD`; if either is unset every `/api` call returns 500. Rollout order is in `docs/development.md`.
- Write authorization (worker): every non-ingest write authorizes itself in its handler (`albumRole`, `faceRoles`, `personRole`)
  and is registered with `guardedWrite` in `worker/src/index.ts` (`guardedWrites`); `worker/test/sharing-writes.test.ts` fails
  otherwise. `POST /ingest/photo` requires `ownerEmail` (trimmed, lowercased email): it returns 409 for an album owned by another
  user and stamps the owner on an unowned album once (one extra single-row write). `shared_with` is only ever written as valid
  JSON or NULL.
- Invite-only access: the Cloudflare Access group `pixdex-approved` is the ONLY gate. The PixdeX Access application allows only that
  group, so strangers are rejected at the edge before the Function or Worker runs; there is no app-level allowlist check (it would cost a
  D1 read per call). Album sharing does NOT grant login: sharees must already be in the group. Requests live in `access_requests`
  (migration `0019_access_requests.sql`: `id`, `email` UNIQUE lowercase by trigger, `note`, `status`, `created_at`, `decided_at`; index
  `idx_access_requests_status_created`). Status is `pending`, `approved`, `denied` or `revoked`; enroll only ever inserts `pending` and never
  reopens a row (a denied or revoked email stays silent). Transitions (each guarded by `WHERE status IN (...)`): approve from `pending`,
  `denied` or `revoked`; deny from `pending` only; revoke from `approved` only. Only the admin, identified by the Worker secret `ADMIN_EMAIL`
  (lowercased; `isAdmin`/`requireAdmin` in `worker/src/admin.ts`), can read or decide: this is a narrow exception to "the Worker never
  reads `OWNER_EMAIL`" (that stays true; `ADMIN_EMAIL` is a separate setting, normally the same address). Worker routes: `POST /enroll`
  (`requireProxyToken`: READ_TOKEN bearer only, no `X-Viewer-Email`; body `{ email, note? }`; always 202 `{ok:true}` for a valid body whether the
  email is new, known in any status or the pending cap of 200 is full, so it cannot be used to enumerate; 400 invalid body; 429 from the
  `ENROLL_LIMITER` Rate Limiting binding, 5 per 60 s keyed by the `X-Client-IP` the Function forwards, checked first, an absent binding means
  no limit), `GET /admin/requests?status=` (`{ requests, pendingCount, queueFull }`, newest first, at most 200) and
  `POST /admin/requests/:id/approve|deny|revoke`. Admin routes answer 404 to non-admins, 409 for a wrong state or a lost race, 400 when deny
  or revoke targets the admin email, 502 when a Cloudflare call fails (the row is left unchanged; the error never carries the token or a
  response body). Approve adds the email to the group (`worker/src/cf/accessApi.ts`: GET the group, change only email includes, PUT, one retry
  on a conflict); revoke removes it and then calls the Access revoke-user-sessions API, so an open session ends at once; deny only sets the
  status. A revoke whose second step fails leaves the row `approved` while the email may already be out of the group (retry recovers; both
  calls are idempotent). Concurrent approvals of different emails can lose a group update (read-modify-write); the admin UI runs one
  action at a time. A concurrent revoke and approve from two browser tabs can likewise re-add a revoked email (the group edit is
  GET-then-PUT; one tab runs one action at a time, two tabs can still race); recovery is to revoke again. The admin page hides Revoke on
  the admin's own row (the Worker answers 400 too). `POST /enroll` is the one write exempt from `guardedWrite`/`guardedWrites` (it authorizes by token, not by album or
  person; `worker/test/sharing-writes.test.ts` lists it as an explicit exception). Config: Worker secrets `ADMIN_EMAIL`, `CF_API_TOKEN`,
  `CF_ACCOUNT_ID`, `CF_ACCESS_GROUP_ID`; Pages variables `TURNSTILE_SECRET` and `TURNSTILE_SITE_KEY` (the site key is public); the
  `[[ratelimits]]` binding in `worker/wrangler.toml` (`namespace_id`: 7410061 is a valid id; change it only if the account already has a rate limiter with that id). The
  Cloudflare token (one permission, "Access: Organizations, Identity Providers, and Groups Write") can add anyone to the group, so it is as
  sensitive as the admin login: Worker secret only, never in Pages, the browser or a `VITE_` variable. Rollout (order matters) and the seed
  script `cd worker && npm run seed-access` (dry-run first; requires exactly two distinct addresses; fills `access_requests`, NOT the Access
  group, which is filled by hand; an upsert that inserts two `approved` rows and upgrades a `pending` row for those two addresses to
  `approved`, leaving an approved, denied or revoked row untouched) are in `docs/development.md`. Performance: enroll is one rate-limit binding call plus at most 1 indexed count over at most
  200 pending rows plus at most 1 write (0 writes for a duplicate or a full queue), trivial CPU; the public `POST /api/enroll` relays only
  the Worker's 202, 400 and 429 and maps every other Worker status to a generic 502 `Upstream unavailable`; admin list is 2 statements in one batch, at most
  200 rows, no OFFSET; admin actions are 1 primary-key read and at most 1 write plus Cloudflare calls: approve 2 (1 if already a member, 4 on a
  conflict retry), revoke 3 (2 if not a member, 5 with a retry), deny none; `/me` still reads no D1 (one env var); the browse hot path is unchanged, and strangers now cost nothing because Access stops them
  at the edge. Turnstile, the Access API, the bypass behaviour and the rate-limit binding cannot be measured locally.
- `functions/api/` - Cloudflare Pages Function: token-adding read proxy (reads
  include `GET timeline`, `GET timeline/buckets`, `GET people/known`, `GET people/review-queue`, `GET people/:id/auto-faces`, `GET people/:id/faces`, `GET albums/contents` and `GET me`; also forwards the
  browser writes (JSON bodies only): `PUT albums/cover`, `PUT albums/shares`, `PUT albums/framing`, `PATCH photos/:id`,
  `PATCH`/`DELETE people/:id`, `PUT`/`DELETE people/:id/label`, and `POST` to `people`, `people/:id/faces`,
  `people/:id/match`, `people/:id/cover`, `people/:id/auto-faces/review`, `faces/:id/assign|reject|unassign`; admin: `GET admin/requests` and
  `POST admin/requests/:id/approve|deny|revoke`, which the Worker restricts to `ADMIN_EMAIL`). It first verifies the Cloudflare Access
  JWT (`functions/_lib/access.ts`) and forwards the verified email as `X-Viewer-Email`; for `GET originals/:id` it first calls the
  Worker `GET /access/photo/:id` (READ_TOKEN, not in the browser allowlist) for every user
- `functions/enroll.ts` and `functions/api/enroll.ts` - the only public paths (an Access Bypass application covers exactly `/enroll` and
  `/api/enroll`), so no Access JWT check. `GET /enroll` is a self-contained HTML page (inline CSS and script under a per-response CSP
  nonce, Turnstile widget, nothing from `/assets/*`; 503 without both Turnstile variables). `POST /api/enroll` runs: method (405 for
  anything but POST, so it never falls through to the authenticated proxy), config, 4 KB body cap (413), JSON and shape check (400),
  Turnstile `siteverify` (`functions/_lib/turnstile.ts`, fails closed: 403 unless a clear success), then one Worker `POST /enroll` with
  READ_TOKEN and `X-Client-IP` (headers are built from scratch). No Worker call or D1 read happens before Turnstile passes.
- `functions/_lib/` - shared Function code: Access JWT verification (`access.ts`, JWKS cached in module memory), Turnstile validation (`turnstile.ts`)
