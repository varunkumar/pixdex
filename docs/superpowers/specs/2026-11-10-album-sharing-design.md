# Album sharing (read-only viewers)

Date: 2026-11-10. Status: draft for owner review.

## Intent

The owner wants to share albums with other people the way Google Photos does,
but with PixdeX's browse and search experience, and with the photo data staying
local to the owner. A viewer signs in with their Google account and sees a full
PixdeX scoped to the albums shared with them. Viewers can never change anything.

## Roles

There is no global role. Authorization is per album, for a signed-in user (an
email):

- **Owner of an album**: the user's email equals the album's owner. Can edit
  everything in it (ratings, overrides, cover) and manage its sharing.
- **Viewer of an album**: the user's email is in the album's `shared_with` list
  and they are not its owner. Read-only.
- **No access**: anything else.

One person can be both: owner of their own albums and viewer of albums shared
with them. The UI and the Worker both decide per album, never from a global
flag. Owners and viewers search and browse across everything they can see (own
albums plus albums shared with them).

Today only one person can add photos, so every album is owned by the
configured `OWNER_EMAIL` (the "default owner"). An album whose `owner_email`
is NULL belongs to the default owner, so no data migration needs the secret
email. Ownership lives on the album only: a photo's access is its album's
access, and photos with no album belong to the default owner. The data model
and checks already support other owners; only the ingest path for them is
deferred (see Non-goals).

People management (creating, renaming and deleting persons, assigning and
rejecting faces, matching, person covers) is library-wide, not per album, and
stays with the default owner only. Any user can read people, scoped to the
photos they can see.

## Goals

- A viewer sees the normal UI (timeline, albums, search, people, photo detail,
  daily pick) limited to shared albums.
- Search, timeline, daily pick, people and faces for a viewer are all computed
  from shared-album photos only. The owner's view is unchanged.
- People names and face crops appear to a viewer only through photos in shared
  albums. Person photo counts shown to a viewer count only shared photos.
- Every write is rejected in the Worker for a user who does not own the resource,
  not just hidden in the UI.
- Sharing is managed by the owner from the album, by email.
- Controls a user cannot use on a given album or photo are hidden in the UI (rating, caption and tag
  edit, cover change, people and face actions, share control).

## Non-goals

- Other people adding photos or running an agent. The data model and checks
  support other owners, but ingest stays default-owner only through
  `INGEST_TOKEN`. Add TODOs (`TODO.todo`): "Support other users adding their own
  photos (per-user ingest tokens that set owner_email)", "Allow the same album
  name under different owners (photos.owner_email, (owner_email, name) key)", "Per-owner people management".
- Share links, public albums, expiry, per-viewer comments or favourites.
- Viewers downloading originals beyond what the existing originals route
  already serves for a visible photo.
- Notifying viewers by email.

## Anti-goals (a failure even if it technically works)

- A viewer can learn that an unshared album, photo or person exists (count,
  name, thumbnail, 403 vs 404 differences). Unshared things return 404.
- A write reaches D1 on behalf of a viewer by any route, including routes that
  are proxied today.
- Owner-edited data (`user_*` columns, covers, person assignments) is affected
  by sharing in any way.
- `READ_TOKEN`, `INGEST_TOKEN` or `ORIGINALS_TOKEN` reaches the browser.

## Identity and request path

Decided by the owner: Cloudflare Access lets any Google account through, and
PixdeX enforces access itself.

- The Pages site stays behind Cloudflare Access with Google as the identity
  provider, but the Access policy changes from "owner only" to "any Google
  account". This is a manual Access dashboard change, documented in
  `docs/development.md`, and must happen when this ships.
- The Pages Function (`functions/api/[[path]].ts`) reads the
  `Cf-Access-Jwt-Assertion` header and **verifies the JWT** (signature against
  the team's JWKS, `aud`, `exp`) before trusting the email claim. Reading the
  `Cf-Access-Authenticated-User-Email` header alone is not enough. No valid JWT
  means 401. Keep JWKS caching in the Function so verification stays cheap.
- The Function forwards the verified email to the Worker in a header (for
  example `X-Viewer-Email`) alongside the existing `READ_TOKEN`. The Worker
  trusts that header only because the request carries `READ_TOKEN`, which only
  the Function holds. The Function must drop any client-supplied copy of that
  header.
- The Worker derives the user: the lowercased email, plus `isDefaultOwner` (the
  email equals `OWNER_EMAIL`). A missing header is rejected.
  Emails are normalized to lowercase everywhere (stored and compared).
- `OWNER_EMAIL` and the Access team domain and audience tag are new config
  (Pages env for the Function, Worker var for `OWNER_EMAIL`). Document them in
  `docs/architecture.md`.

## Data model

New additive migration 0016 (next number after 0015):

- `albums.owner_email TEXT` (nullable, lowercase; NULL means the default owner).
  Owner-edited like `shared_with`: the refresh upsert never names it, so
  rebuilds preserve it, and a newly created album row starts NULL. Ingest never
  sets it today; a future multi-owner ingest sets it after creating the album.
  Nothing is stored on `photos` (no `photos.owner_email`).
- `albums.shared_with TEXT`: a JSON array of lowercase emails, NULL when not
  shared. Owner-edited, with the same upsert rule.
- No trigger or generator logic changes: 0016 is a plain `ALTER TABLE albums ADD
  COLUMN` pair (the generator gets a comment that the two columns are owner-edited
  and deliberately absent from the upsert). `AGENTS.md` rule update: `albums` is
  trigger-derived except `owner_email` and `shared_with`, written only by the
  share route (and later by multi-owner ingest).
- When an album's last photo leaves, its row (and shares) is deleted. Accepted.
- Invariant: an album is identified by its name, and names are unique across
  the library, so "album name plus owner is unique" holds. Ingest enforces the
  owner half: a photo whose album name already exists with an `owner_email`
  other than NULL or `OWNER_EMAIL` is rejected with 409 and nothing is written.
  Letting two owners use the same name needs `photos.owner_email` and a
  `(owner_email, name)` album key; that is deferred to the multi-owner ingest
  work and recorded in the TODO.
- `move-album` does not change `photos.album`, so it needs no sharing handling.

## Access scoping (reads)

Every read route filters by what the signed-in user can see. A photo is visible
to user U when `photos.album` is in the set of albums U owns or has shared with
them: albums where `owner_email = U` (or `owner_email IS NULL` when U is the
default owner) or `shared_with` contains U (a small subquery on the `albums`
table, for example `SELECT name FROM albums WHERE owner_email = ? OR EXISTS
(SELECT 1 FROM json_each(shared_with) WHERE value = ?)`, inlined so it is one
round trip). Photos with a NULL album are visible only to the default owner
(`photos.album IS NULL OR photos.album IN (...)` for them).

- Routes to scope: `GET /search`, `/timeline`, `/timeline/buckets`, `/albums`,
  `/daily-pick`, `/photos/:id`, `/photos/:id/faces`, `/thumbnails/:contentHash`,
  `/people`, `/people/groups`, `/faces/:id/crop`, and originals.
- `/albums` returns albums the user owns or has shared with them. Each item
  carries the user's role for it (`role: 'owner' | 'viewer'`); `sharedWith` is
  included only when the role is owner.
- Every serialized photo carries `canEdit: boolean` (true when the user owns its
  album, or it has no album and the user is the default owner); owner emails are
  never sent.
- `/search` and `/timeline` with an `album` filter for an invisible album return
  an empty result, same as a nonexistent album. A viewer's unfiltered search must
  count visible rows, not the global `counters` total.
- `/people` lists only persons with at least one visible face, with face and
  photo counts over visible photos and a cover chosen among visible faces.
  `/people/groups` (unassigned faces, an owner triage tool) is empty unless the
  user is the default owner.
- `/photos/:id`, `/photos/:id/faces`, thumbnails (resolved to a visible photo by
  content hash), face crops and originals return 404 for an invisible photo.
- Originals are served from the default owner's machine through a tunnel and the
  Function does not read D1. For the default owner the Function skips the check
  (the tunnel only holds their files). For anyone else the Function first asks
  the Worker (`GET /access/photo/:id`, 204 or 404) and proxies only on 204.
- `GET /me` returns `{ email, isDefaultOwner }`.

**Cost to report before shipping.** Reads for the default owner can no longer skip
filtering, since they must include albums shared with them. The added predicate
is `photos.album IS NULL OR photos.album IN (<albums subquery>)`. It uses only
the `album` column that `idx_photos_album` and `idx_photos_album_cover` already
cover, so index-only plans should survive, and the subquery reads one row per
album from the small `albums` table. The builder confirms with `EXPLAIN QUERY
PLAN` on search, timeline and buckets, and reports rows read before and after.

## Access scoping (writes)

Writes are checked per resource in the Worker; the UI hides what the Worker
would reject.

- Album and photo writes need ownership of the album: `PATCH /photos/:id`
  (owner of the photo's album, or default owner for a photo with no album), `PUT /albums/cover` and `PUT
  /albums/shares` (owner of the album). A non-owner gets 403 and the database
  is unchanged. An invisible resource returns 404, not 403.
- People management is default-owner only (403 otherwise): `POST /people`,
  `PATCH`/`DELETE /people/:id`, `POST /people/:id/faces|match|cover`, `POST
  /faces/:id/assign|reject|unassign`.
- A route-enumeration test fails if any non-GET route outside `/ingest/*` has
  neither a per-resource ownership check nor the default-owner guard, so a new
  write route fails safe.
- `/ingest/*` stays out of the proxy allowlist, unchanged.

## Sharing management

- New owner-only Worker route to set an album's shared list, for example
  `PUT /albums/shares` with `{ album, emails }` (replace semantics), forwarded by
  the Function and added to its `PUT` allowlist. It validates and lowercases
  emails, caps list size (for example 50), rejects unknown albums with 404, and
  writes only `albums.shared_with` (NULL when the list is empty).
- Owner UI: a "Share" control on each album (albums page and album view) that
  opens a small dialog listing current emails with add and remove. Shown only
  for albums the user owns.
- The owner's albums list response should include `shared_with` for the owner
  only (to render the dialog and a "shared" badge). Viewers never receive the
  list of other viewers.
- Albums the user views (not owns) show a "shared with you" indication (builder's call on
  exact wording and placement, kept minimal).

## Frontend

- Edit affordances are gated per item, not by a global flag. Photo-level controls
  (rating, title, subjects, tags) use `photo.canEdit`; album-level controls
  (cover pick, share) use the album item's `role === 'owner'`; people management
  (create, rename, delete, face assign/reject/unassign, match, person cover) uses
  `isDefaultOwner` from `GET /me`. Hidden, not disabled. While `/me` is loading,
  people controls stay hidden.
- The `/ai-search` page (Chrome Prompt API, client side) must also use only
  scoped data, since it calls the same `/api/*` routes. Verify it needs no change
  beyond that.

## Constraints from the project rules

- Performance review is mandatory and must appear in the plan and summary:
  state Worker CPU and D1 rows read and written per request, use
  `EXPLAIN QUERY PLAN` on the scoped queries, avoid N+1, and keep the owner path
  cost unchanged. The viewer visible-album set is a scan of the small `albums`
  table (one row per album) with `json_each`; state its cost and whether an
  index or a derived lookup table is warranted. Anything that raises cost on a
  hot path must be reported to the owner before shipping.
- Worker CPU budget is 10 ms per invocation on the free plan. JWT verification
  is done in the Pages Function, not the Worker.
- Zod in `worker/` via `import * as z from 'zod/mini'`.
- DB changes only through a new numbered migration; additive.
- Update `README.md`, `AGENTS.md` and `docs/` (architecture, development) in the
  same commit as the feature.
- Do not commit `.env`, `credentials/` or `agent/.index-state/`.

## Testing expectations

- Worker tests for every read route as owner, as a viewer with a share, as a
  viewer without a share (404 or empty), and with no identity header (rejected).
- Worker tests that every write route returns 403 for a viewer and is unchanged
  for the owner. A test that enumerates registered write routes to catch new
  unguarded ones is encouraged.
- Function tests for JWT verification failure paths and for dropping a
  client-supplied identity header.
- Frontend tests that edit controls are absent for a viewer.
- Migration test: `shared_with` survives album refresh triggers and is lost only
  when the album empties.

## Left to the builder

- JWT verification library and JWKS caching approach in the Function.
- How the role reaches the client, and the originals authorization mechanism.
- Exact route names, share dialog layout, and the "shared with you" treatment.
- Whether to add an index or lookup table for the visible-album set, based on
  measured query plans.
- The albums-generator change details.

## Calls made by the assistant (not discussed with the owner)

- **Rollout order.** Deploy the new Function and Worker first, then change the
  Access policy to "any Google account". Written into `docs/development.md`.
  Opening Access first would give any Google user owner-level access through the
  old code. The Worker fails closed (rejects all requests) when `OWNER_EMAIL` is
  unset.
- **Local dev.** `npm run dev` talks to the Worker through the Vite proxy, not the
  Pages Function, so the proxy adds an `X-Viewer-Email` header from an optional
  local variable `DEV_VIEWER_EMAIL` (default: the Worker's `OWNER_EMAIL` value
  from the local env file). There is no bypass in the Function, so production
  cannot enable one.
- **`move-album`.** It only rewrites `photos.path` and never changes
  `photos.album`, so sharing is unaffected and nothing needs to change there
  (corrects the earlier "sharing follows the album" note).
- **Person cover and face crops.** If a person's cover is in an unshared photo,
  a viewer gets the first visible face of that person as the cover. The query
  stays bounded and its extra cost is reported in the plan.
- **Email matching.** Exact match on the lowercased address, no Gmail dot or
  `+tag` normalization. The share dialog notes that the address must match the
  person's Google sign-in email.
- **Daily pick.** Per-viewer pick drawn from visible photos, never cached across
  viewers.

## Open assumptions to confirm

- Cloudflare Access with Google as the identity provider is already the login
  (stated by the owner). The Access policy change to "any Google account" is a
  manual step by the owner.
- Only album membership via `photos.album` determines visibility. Photos with
  no album are owner-only.
