# Album Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let people share albums with other Google accounts as read-only viewers, with authorization per album so one person can own some albums and view others.

**Architecture:** The Pages Function verifies the Cloudflare Access JWT and forwards the verified email in `X-Viewer-Email`. The Worker turns it into a `User` (email plus `isDefaultOwner`), filters every read by the albums the user owns or has shared with them (`albums.owner_email`, `albums.shared_with`), and checks ownership of the album on every write. People management stays default-owner only.

**Tech Stack:** Hono Worker (D1, R2, `zod/mini`), Cloudflare Pages Functions (WebCrypto), React 19 + Mantine + TanStack Query, Vitest (`@cloudflare/vitest-pool-workers` in `worker/`, jsdom at the root).

**Spec:** `docs/superpowers/specs/2026-11-10-album-sharing-design.md`

## Global Constraints

- No global role. For user U and album A: owner if `A.owner_email = U` (NULL means the default owner, i.e. U equals `OWNER_EMAIL`), viewer if U is in `A.shared_with` and not the owner, else no access. Photos with `album IS NULL` belong to the default owner. Nothing is stored on `photos`.
- Emails are stored and compared lowercased and trimmed, exact match (no Gmail dot or `+tag` rules). Max 50 emails per album.
- Invisible things return 404 (or an empty list), never 403. A visible album or photo the user does not own returns 403 on write.
- People management (`POST /people`, `PATCH`/`DELETE /people/:id`, `POST /people/:id/faces|match|cover`, `POST /faces/:id/assign|reject|unassign`) is default-owner only (403 otherwise). `/people/groups` is empty for anyone else.
- In `worker/`: `import * as z from 'zod/mini'`, never `'zod'`. DB changes only as a new additive numbered migration (0016). Album names stay globally unique, so name plus owner is unique; ingest rejects a photo whose album name exists with an `owner_email` that is neither NULL nor `OWNER_EMAIL` (409, nothing written).
- `albums` stays trigger-derived except the two owner-edited columns `owner_email` and `shared_with`, which the refresh upsert never names.
- `/ingest/*` stays out of the Pages proxy allowlist and ingest bodies cannot set `owner_email` or `shared_with`. `READ_TOKEN`, `INGEST_TOKEN`, `ORIGINALS_TOKEN` never reach the browser.
- Owner emails other than the caller's own are never sent to the browser. `sharedWith` appears only on albums the caller owns.
- No em dashes in any text or docs. A pre-commit hook runs the touched suites; do not bypass it.
- Rollout order: deploy code first, then change the Access policy to any Google account. The Worker fails closed (401 on every read) when `OWNER_EMAIL` is unset.

## Review Focus

1. A non-default-owner's unfiltered search must not use the global `counters` photo total (it would leak the library size): count with the visibility filter. Test in Task 3.
2. `/timeline/buckets` and `/albums` totals count only visible photos and albums. Test in Task 3.
3. Header variants (`Viewer@Example.COM`, surrounding spaces) match a share or ownership; an empty or missing header is 401. Test in Task 1.
4. One user who owns album X and is shared album Y (owned by someone else) sees both, can write X, gets 403 writing Y, and the other owner cannot see X. Test in Task 5.
5. Unsharing takes effect on the next request; an empty list stores NULL; duplicate emails collapse. Test in Task 5.
6. A person with faces in visible and invisible photos shows visible counts only and a visible cover; a person with no visible face is absent. Test in Task 4.

## File Structure

- `worker/src/access.ts` (new): `User`, `userOf`, `albumRole`, `requireDefaultOwner`.
- `worker/src/db/visibility.ts` (new): SQL fragments that scope queries to a user.
- `worker/src/routes/shares.ts` (new): `GET /me`, `PUT /albums/shares`, `GET /access/photo/:id`.
- `worker/src/routes/*.ts`, `worker/src/auth.ts`, `worker/src/index.ts`, `worker/src/types.ts`, `worker/src/db/photos.ts` (modify).
- `worker/migrations/0016_album_shares.sql` (new), `worker/migrations/index.ts`, `worker/migrations/albums.ts` (comment) (modify).
- `functions/_lib/access.ts` (new): JWT verification. `functions/api/[[path]].ts` (modify).
- `src/hooks/useMe.ts`, `src/components/ShareAlbumModal.tsx` (new); `WorkerApiClient.ts` and the write-using components (modify).

---

### Task 1: Worker identity

**Files:**
- Create: `worker/src/access.ts`, `worker/src/routes/shares.ts` (with `meRoute` only), `worker/test/access.test.ts`, `worker/test/helpers.ts`
- Modify: `worker/src/types.ts`, `worker/src/auth.ts`, `worker/src/index.ts`, `worker/vitest.config.ts`
- Modify (mechanical): the 13 existing `worker/test/*.test.ts` files that send `Authorization: Bearer ${env.READ_TOKEN}`

**Interfaces:**
- Produces (`access.ts`): `interface User { email: string; isDefaultOwner: boolean }`; `userOf(c: Context<{ Bindings: Env }>): User` (reads `X-Viewer-Email`, lowercases and trims, `isDefaultOwner` from `c.env.OWNER_EMAIL`); `requireDefaultOwner` Hono middleware returning `c.text('Forbidden', 403)` otherwise.
- Produces (`helpers.ts`): `readHeaders(email?: string): Record<string, string>` returning `Authorization` plus `X-Viewer-Email` (default `OWNER_TEST_EMAIL`); exports `OWNER_TEST_EMAIL = 'owner@example.com'`.
- Produces (`auth.ts`): `requireReadToken` also returns 401 when `OWNER_EMAIL` is unset or `X-Viewer-Email` is missing or blank.
- Produces: `GET /me` returns `{ email, isDefaultOwner }`.

- [ ] **Step 1: Write failing tests in `worker/test/access.test.ts`**: the owner header gives `{ isDefaultOwner: true }` from `/me`; `Viewer@Example.COM ` gives `{ email: 'viewer@example.com', isDefaultOwner: false }`; missing header, blank header, and a missing read token each give 401; `/health` stays open.
- [ ] **Step 2: Run** `cd worker && npx vitest run test/access.test.ts`. Expect FAIL (no `/me`).
- [ ] **Step 3: Implement** `Env.OWNER_EMAIL: string`, `access.ts`, the `requireReadToken` change, `meRoute`, and `app.use('/me', requireReadToken); app.get('/me', meRoute)`. In `vitest.config.ts` pass `cloudflareTest({ wrangler: {...}, miniflare: { bindings: { OWNER_EMAIL: 'owner@example.com' } } })` so the owner address is a fake test value, not committed config.
- [ ] **Step 4: Add `worker/test/helpers.ts`** and replace every `{ Authorization: \`Bearer ${env.READ_TOKEN}\` }` headers object in the existing tests with `readHeaders()` (add the import). Run `cd worker && npm test`. Expect all PASS.
- [ ] **Step 5: Commit** `feat(worker): resolve the signed-in user from the forwarded identity`.

---

### Task 2: Album ownership and share columns, visibility SQL

**Files:**
- Create: `worker/migrations/0016_album_shares.sql`, `worker/src/db/visibility.ts`, `worker/test/visibility.test.ts`
- Modify: `worker/migrations/index.ts` (append the two `ALTER TABLE albums ADD COLUMN` statements to `PHOTOS_MIGRATION_STATEMENTS`), `worker/migrations/albums.ts` (comment only: `owner_email` and `shared_with` are owner-edited and deliberately absent from the upsert `DO UPDATE SET` list)

**Interfaces:**
- Produces (`visibility.ts`): `visibleAlbumsSql(user: User): { sql: string; params: unknown[] }` returning `(SELECT name FROM albums WHERE <owner clause> OR EXISTS (SELECT 1 FROM json_each(albums.shared_with) WHERE value = ?))` where the owner clause is `(owner_email IS NULL OR owner_email = ?)` for the default owner and `owner_email = ?` otherwise; `scopeFor(user: User, column: string): { sql: string; params: unknown[] }` returning ` AND (${column} IS NULL OR ${column} IN <subquery>)` for the default owner and ` AND ${column} IN <subquery>` otherwise; `async scopeForRequest(db: D1Database, user: User, column: string): Promise<{ sql: string; params: unknown[] }>` returns the empty scope when the user is the default owner and no album has a non-NULL `owner_email` (`SELECT EXISTS(SELECT 1 FROM albums WHERE owner_email IS NOT NULL)`, one small-table query), else `scopeFor`. This keeps today's owner-only cost: with no other owners the default owner sees everything and may use the `counters` total.

- [ ] **Step 1: Write failing tests**: seed albums through photo inserts (triggers build them); set `shared_with` and `owner_email` by direct SQL; assert `scopeFor` selects exactly: default owner gets own (NULL-owner) albums, NULL-album photos and shared ones; a non-default user gets owned and shared albums only and no NULL-album photos; a refresh (insert another photo into an album) preserves both columns; deleting an album's last photo removes the row.
- [ ] **Step 2: Run** `npx vitest run test/visibility.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the migration (identical SQL in the `.sql` file and `index.ts`) and `visibility.ts`. Add a test that `scopeForRequest` is empty for the default owner until an album gets a non-NULL `owner_email`, and never empty for anyone else.
- [ ] **Step 4: Check plans** with `EXPLAIN QUERY PLAN` for `SELECT id FROM photos WHERE album IS NULL OR album IN (<subquery>)` and for the search and timeline queries as the default owner. Record whether the covering index (`idx_photos_album`) is still used, and rows read before and after, in the PR description. If an index-only plan is lost, stop and report to the owner before continuing.
- [ ] **Step 5: Run** `cd worker && npm test && npm run typecheck`. Expect PASS. **Commit** `feat(worker): add albums.owner_email, albums.shared_with and visibility SQL`.

---

### Task 3: Scope the photo reads

**Files:**
- Modify: `worker/src/routes/search.ts`, `worker/src/routes/timeline.ts`, `worker/src/routes/photos.ts` (`getPhotoRoute`, `getAlbumsRoute`), `worker/src/routes/ingest-thumbnail.ts` (`getThumbnailRoute`), `worker/src/routes/faces.ts` (`photoFacesRoute`, `faceCropRoute`), `worker/src/db/photos.ts` (`serializePhoto`)
- Test: `worker/test/sharing-reads.test.ts`

**Interfaces:**
- Consumes: `userOf`, `scopeFor`, `visibleAlbumsSql`.
- Produces: `serializePhoto(row: PhotoRow, canEdit: boolean)` adds `canEdit` to every serialized photo (callers compute it: the user owns the photo's album, or the photo has no album and the user is the default owner; a helper `canEditPhoto(user: User, ownedAlbums: ..., row)` is the builder's call). `GET /albums` paged items gain `role: 'owner' | 'viewer'` and `sharedWith?: string[]` (only when `role` is `owner`).

- [ ] **Step 1: Write failing tests** with one seeded library (albums `Kanha` owned by default owner and shared with `viewer@example.com`, `Ranthambore` owned by default owner and unshared, one NULL-album photo, album `Sundarbans` with `owner_email = 'other@example.com'`), as the default owner, `viewer@example.com`, and `stranger@example.com`:
  - `/search` (no q, with q, `?album=Ranthambore`), `/timeline` (month and day zoom), `/timeline/buckets`: the viewer gets only Kanha; the stranger gets nothing; a hidden album filter returns empty; `total` and bucket counts exclude hidden photos (Review Focus 1 and 2); the default owner sees Kanha, Ranthambore and the NULL-album photo, not Sundarbans.
  - `/albums` (bare, `names=1`, paged) lists only visible albums, `total` counts only them, `role` is correct, `sharedWith` appears only for owned albums.
  - `/photos/:id`, `/photos/:id/faces`, `/thumbnails/:hash`, `/faces/:id/crop` return 404 for hidden photos and 200 for visible ones; `canEdit` is true only where the user owns the album.
- [ ] **Step 2: Run** `npx vitest run test/sharing-reads.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** Search and timeline: compute `scopeForRequest(c.env.DB, user, 'photos.album')` once per request and append it inside `run()` and `scopeSql`; set `unfiltered` false whenever the scope is non-empty (so the `counters` shortcut survives only for the default owner while no other-owned album exists). Albums: add `WHERE name IN <visibleAlbumsSql>` and apply it to the `COUNT(*)`. Photo, faces, crop: add the album predicate to the lookup query. Thumbnail: first run `SELECT 1 FROM photos WHERE content_hash = ? <scopeFor>` (content_hash is UNIQUE, so a point lookup) and return 404 when absent; set the thumbnail `Cache-Control` to `private, max-age=31536000, immutable`.
- [ ] **Step 4: Run** `cd worker && npm test && npm run typecheck`. Expect PASS. **Commit** `feat(worker): scope photo reads to the albums a user can see`.

---

### Task 4: Scope people, faces and daily pick

**Files:**
- Modify: `worker/src/routes/people.ts` (`listPeopleRoute`, `groupsRoute`), `worker/src/routes/daily-pick.ts`
- Test: `worker/test/sharing-people.test.ts`

**Interfaces:**
- Consumes: `userOf`, `scopeFor`.
- Produces: `/people` lists only persons with at least one visible confirmed or auto face, with `faceCount` and `photoCount` over visible photos and a cover chosen among visible faces; `/people/groups` returns `{ groups: [], scanned: 0, nextCursor: null }` unless `isDefaultOwner`; `/daily-pick` for non-default-owners is read-only (never writes `instagram_suggested`), drawn from visible photos, 404 `No photos available` when none.

- [ ] **Step 1: Write failing tests**: a person with faces in a visible and an invisible photo shows visible counts only; a person with only invisible faces is absent for the viewer and present for the default owner; a `cover_face_id` in an invisible photo yields a visible face as `cover` (Review Focus 6); `/people/groups` is empty for the viewer; viewer `/daily-pick` returns a visible photo and leaves every `instagram_suggested` unchanged; default-owner `/daily-pick` behavior is unchanged (existing `daily-pick.test.ts` passes).
- [ ] **Step 2: Run** the new file. Expect FAIL.
- [ ] **Step 3: Implement.** People list for non-owners: `JOIN faces f ... JOIN photos ph ON ph.id = f.photo_id` with `scopeFor(user, 'ph.album')` and `HAVING COUNT(f.id) > 0`; apply the same predicate to the cover query's WHERE (`FACE_SELECT` already joins `photos ph`). Daily pick for non-default-owners: `SELECT ${SELECT_COLUMNS} FROM photos WHERE 1=1 <scope> ORDER BY ${COMBINED_SCORE_SQL} IS NULL, ${COMBINED_SCORE_SQL} DESC LIMIT 200`, then the existing `hasHuman` filter and `score` pick in memory, no `UPDATE`, no already-picked lookup. The default owner keeps the existing path.
- [ ] **Step 4: Run** `cd worker && npm test && npm run typecheck`. Expect PASS. **Commit** `feat(worker): scope people, faces and daily pick`.

---

### Task 5: Write authorization and the share route

**Files:**
- Modify: `worker/src/access.ts`, `worker/src/index.ts`, `worker/src/routes/shares.ts`, `worker/src/routes/photos.ts` (`patchPhotoRoute`, `putAlbumCoverRoute`), `worker/src/routes/ingest-photo.ts`
- Test: `worker/test/sharing-writes.test.ts`

**Interfaces:**
- Consumes: `userOf`, `requireDefaultOwner`.
- Produces (`access.ts`): `albumRole(db: D1Database, user: User, album: string | null): Promise<'owner' | 'viewer' | null>` (null album: owner for the default owner, else null; named album: owner, viewer, or null for no access).
- Produces (`shares.ts`): `PUT /albums/shares` body `{ album: string, emails: string[] }` returning `{ album, emails }` (404 when the album is invisible to the caller, 403 when the caller is only a viewer, 400 on an invalid email or more than 50, lowercased and deduped, NULL stored when empty, writes only `albums.shared_with`); `GET /access/photo/:id` returns 204 when the caller may see the photo, else 404.
- `PATCH /photos/:id` and `PUT /albums/cover` use `albumRole`: 404 for no access, 403 for viewer.

- [ ] **Step 1: Write failing tests**: a table-driven test sends each people-management write as the default owner (existing success) and as a non-default user (403, database unchanged); `PATCH /photos/:id`, `PUT /albums/cover`, `PUT /albums/shares` as album owner (success), as a viewer of that album (403, unchanged), and as a stranger (404); Review Focus 4 (one user owns X and is shared Y); share route validation and Review Focus 5 (unshare, empty list stores NULL, dedupe, `Viewer@x.com` and `viewer@x.com` collapse); a test enumerates `app.routes` and fails if any non-GET route outside `/ingest/*` has neither an `albumRole` check nor `requireDefaultOwner`; ingest request bodies carrying `owner_email` or `shared_with` do not change those columns; `POST /ingest/photo` into an album name whose row has `owner_email = 'other@example.com'` returns 409 and writes nothing, while a name with NULL or `OWNER_EMAIL` as owner (or a new name) succeeds; `/access/photo/:id` for visible, hidden and unknown ids.
- [ ] **Step 2: Run** the new file. Expect FAIL.
- [ ] **Step 3: Implement.** Register `requireDefaultOwner` on the people write routes in `index.ts`. Add `albumRole`, `putAlbumSharesRoute` and `accessPhotoRoute` (zod/mini schema; lowercase before store; write only `UPDATE albums SET shared_with = ? WHERE name = ?`). Add the ownership check to `patchPhotoRoute` and `putAlbumCoverRoute`. In `ingestPhotoRoute`, when the body has an album, run one `SELECT owner_email FROM albums WHERE name = ?` before the insert and return 409 per the invariant (one small-table point lookup on the ingest path only). To satisfy the enumeration test, mark guarded routes by a small exported registry (for example `guardedWrites: Set<string>`) that `index.ts` fills when registering, builder's choice of mechanism.
- [ ] **Step 4: Run** `cd worker && npm test && npm run typecheck`. Expect PASS. **Commit** `feat(worker): per-album write authorization and the share route`.

---

### Task 6: Pages Function identity, forwarding and originals

**Files:**
- Create: `functions/_lib/access.ts`, `functions/_lib/access.test.ts`, `functions/api/proxy.test.ts`
- Modify: `functions/api/[[path]].ts`, `vite.config.ts` (test include `functions/**/*.test.ts`; dev proxy adds `X-Viewer-Email`), `.env.example`

**Interfaces:**
- Produces (`access.ts`): `verifyAccessJwt(token: string | null, env: { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string }, fetchFn?: typeof fetch): Promise<{ email: string } | null>` (RS256 over WebCrypto; checks signature against the team JWKS at `https://${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`, `aud`, `exp`; JWKS cached in module memory for one hour).
- Produces: every request through the Function sets `X-Viewer-Email` from the verified email and returns 401 when the JWT is missing or invalid; a client-supplied `X-Viewer-Email` is never forwarded (headers are built from the allowlist); allowlists gain `^me$` (GET) and `^albums\/shares$` (PUT); for `GET originals/:id` by anyone whose email is not `env.OWNER_EMAIL` the Function first calls Worker `GET /access/photo/:id` with the same headers and returns 404 unless it answers 204; the default owner skips that call.

- [ ] **Step 1: Write failing tests** (`// @vitest-environment node`): valid token returns the email; wrong signature, wrong `aud`, expired, malformed and missing token return null; the Function returns 401 without a JWT; the forwarded request carries the verified email and not a spoofed header; a non-owner original is 404 when the access check returns 404 and proxied when 204; the default owner's original makes no access call.
- [ ] **Step 2: Run** `npx vitest run functions`. Expect FAIL.
- [ ] **Step 3: Implement** `access.ts` and wire it into `onRequestGet` and `forwardWrite`. Add `OWNER_EMAIL`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` to the Function `Env`. Vite dev proxy: add header `X-Viewer-Email: env.DEV_VIEWER_EMAIL || env.OWNER_EMAIL`, documented in `.env.example`.
- [ ] **Step 4: Run** `npm test && npm run lint`. Expect PASS. **Commit** `feat(pages): verify the Access JWT and forward the user identity`.

---

### Task 7: Frontend gating and sharing UI

**Files:**
- Create: `src/hooks/useMe.ts`, `src/components/ShareAlbumModal.tsx`, tests beside them in `__tests__/`
- Modify: `src/services/api/WorkerApiClient.ts` (add `getMe(): Promise<{ email: string; isDefaultOwner: boolean }>`, `setAlbumShares(album: string, emails: string[]): Promise<string[]>`; album summary gains `role: 'owner' | 'viewer'` and optional `sharedWith?: string[]`; serialized photo gains `canEdit: boolean`), `src/components/AlbumCard.tsx`, `AlbumPhotos.tsx`, `PhotoReview.tsx`, `PhotoFaces.tsx`, `PersonPage.tsx`, `People.tsx`, `PhotoDetail.tsx`

**Interfaces:**
- Produces: `useMe(): { email: string | null; isDefaultOwner: boolean; loading: boolean }` (TanStack Query key `['me']`, `staleTime: Infinity`; while loading `isDefaultOwner` is false so people controls never flash).
- Gating: photo review controls use `photo.canEdit`; cover pick and share use the album's `role === 'owner'`; people management uses `isDefaultOwner`.

- [ ] **Step 1: Write failing tests**: with `canEdit: false` the review editor is absent; with `role: 'viewer'` the cover picker and Share button are absent; with `isDefaultOwner: false` create, rename, delete person and assign, reject, unassign and match controls are absent; the same user sees an owned album's controls and a shared album's lack of them in one session (Review Focus 4 in the UI); `ShareAlbumModal` adds, removes and saves emails through `setAlbumShares`, rejects an invalid address inline, and shows the "must match their Google sign-in email" note.
- [ ] **Step 2: Run** `npx vitest run src`. Expect FAIL.
- [ ] **Step 3: Implement** the hook, the modal (Mantine `Modal` with a `TagsInput`), a "Share" button on the album card and album page for owned albums with a small "Shared" badge when `sharedWith` is non-empty, and a "Shared with you" badge on albums with `role === 'viewer'`. Gate each listed component as above. Hidden, not disabled.
- [ ] **Step 4: Run** `npm test && npm run lint && npm run build`. Expect PASS. Check `/ai-search` needs no change (it calls the same scoped `/api/*` routes). **Commit** `feat(web): per-album edit gating and the share dialog`.

---

### Task 8: Docs, TODO and performance record

**Files:**
- Modify: `AGENTS.md`, `README.md`, `docs/architecture.md`, `docs/development.md`, `TODO.todo`, `.env.example`

- [ ] **Step 1: Update** `AGENTS.md` (the `albums` rule: derived except `owner_email` and `shared_with`; new `/me`, `PUT /albums/shares`, `/access/photo/:id` routes; `PUT albums/shares` in the Function write list; per-album authorization and default-owner people rule; Layout mentions `functions/_lib`), `README.md` (sharing feature and config), `docs/architecture.md` (identity flow, `OWNER_EMAIL`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, ownership model), `docs/development.md` (rollout order: deploy first, then open Access to any Google account; set the three variables; local `DEV_VIEWER_EMAIL`).
- [ ] **Step 2: Add to `TODO.todo`**: "Support other users adding their own photos (per-user ingest tokens that set albums.owner_email)", "Allow the same album name under different owners (photos.owner_email and an (owner_email, name) album key)", "Per-owner people management".
- [ ] **Step 3: Record the performance review** in the PR description: while no album has another owner the default owner pays one small `albums` existence query per scoped request and nothing else; once another owner exists, each scoped read gains a predicate `album IS NULL OR album IN (subquery)` and one scan of the small `albums` table, with the Task 2 step 4 `EXPLAIN QUERY PLAN` results and measured rows before and after; the `counters` shortcut is skipped whenever a scope applies; thumbnails add one UNIQUE-index point lookup; originals add one Worker call for non-owners only; daily pick for non-default-owners reads at most 200 rows; `/me` is one request per session with no D1 read. State that CPU and D1 cannot be measured locally and list how to measure (`wrangler tail pixdex-worker --format json`, `wrangler d1 insights pixdex --timePeriod 30d`). If Task 2 step 4 showed a lost index-only plan or raised rows read on search, timeline or buckets, tell the owner before shipping.
- [ ] **Step 4: Run** `npm test && npm run lint && npm run build && (cd worker && npm test && npm run typecheck)`. Expect all PASS. Run `graphify update .`. **Commit** `docs: document album sharing`.
