# PixdeX

Browse and search UI for a personal photo collection. A React frontend talks to
a Cloudflare Worker (D1 + R2); a separate local agent indexes photos with a
local Ollama model and pushes metadata and thumbnails to the Worker. Originals
are never stored on Cloudflare: they stay on local disk or Google Drive and are
fetched on demand, and viewers' browsers keep a copy of album cover originals
(for the album hero).

## Layout

- `src/` - React 19 + Vite + Mantine frontend (calls same-origin `/api/*`);
  the Search page is one omnibox (`src/components/Search.tsx`; bar `src/components/omnibox/Omnibox.tsx`, panel `SuggestionPanel.tsx`,
  data `src/hooks/useOmniboxData.ts`, matcher `src/services/omnibox/matcher.ts`, URL state `src/services/omnibox/urlState.ts`, colours
  `src/components/chipStyle.ts`, dark-mode ink vars `--pixdex-ink-*` in `src/index.css`) with a plain mode and an AI mode (Chrome Prompt API only,
  client side; "Ask AI" / Cmd+Enter and the plain-mode "Add keywords" button, which sets `mode=ai` so keywords can be typed without the
  model, exist only where supported): AI result cards in `src/components/AiResults.tsx`, logic in
  `src/services/aiSearch/`, support gate in `src/hooks/usePromptApiSupport.ts`. In AI mode the page button is "Search again" (commits the
  keyword draft through the `KeywordRowHandle` ref, then re-runs the keywords without the model; Enter in the bar stays a plain search). `/ai-search` is only a redirect
  (`src/components/LegacyAiRedirect.tsx`) to `/search?mode=ai` (old `people=0` becomes `hidePeople=0`; without support the AI params are
  stripped); there is no AI Search nav entry. AI params: `mode=ai`, `q`, `kw`, `hidePeople=0`, `room=0`. `dev/mockApi.ts` is the dev-only dummy API
- Photo grids (`src/components/MasonryGrid.tsx`, `masonry.ts`, `PhotoGrid.tsx`, `PhotoTile.tsx`, `AlbumCard.tsx`, `SortIcons.tsx`, `ColumnsToggle.tsx`,
  `src/hooks/usePhoneColumns.ts`; styles `pdx-*` in `src/index.css`): masonry from each photo's `width / height` (null or zero is 4/3, clamped 0.4 to 3), columns
  2 / 3 / 4 at 0 / 576px / 992px, phones switch between 1 and 2 columns (localStorage `pixdex.phoneColumns`). Hover-capable devices get an overlay
  (compact: the title with its date on one line and one row of tags, or the AI note; the album name on Search and the person page sits at the top left as plain white text with a shadow, no pill), touch devices one caption line (`@media (hover: none)`); both are always in the DOM. `PhotoGrid` props are `badges` (always visible, top left: the Cover badge), `mark`, a small sparkle before the title in the hover text (`pdx-tile-mark`, labelled "Matched automatically" for an auto-matched face on the person page; touch shows a plain sparkle in the caption line), no loud "Auto" label, `actions` (hover-only on a mouse, top right), `note`,
  `showAlbum` (the old `footer` is gone); a touch screen next to a mouse (`any-pointer: coarse`) also gets the caption line and always-visible actions. Icon-only controls carry their photo or album in the accessible name ("Set as cover: <caption>", "Photo actions for <caption>"). The albums page keeps the original `AlbumCard` (bordered card, letterboxed 180px cover, name, count, date, avatar stack, Share button; grid 1 / 2 / 3 / 4 columns) with `SortIcons`; an experiment with image-first album tiles was reverted. The page size is always exactly the selector's value (12, 24, 48): no rounding to the column count. Photo columns are 1 or 2 (phone), 3 and 4 (never 5, so 12 photos still give 3 per column). `MasonryGrid` balances the columns (`balanceColumns`: greedy deal, then moves and swaps between any two columns while the sum of squared heights falls) and gives every column a width proportional to 1 / its height (`columnGrow`, gap included), so all columns end on the same line with tiles in their exact shape; tiles also grow a hair (`flex-grow` by height, `object-fit: cover`) to absorb the pixel gaps. That only happens when `planWidths` says the grid can end flush: every column is filled and the relative widths stay within 0.6 to 1.6 of a normal column. A short page (fewer photos than columns) keeps fixed columns about one normal column wide (`--pdx-col`, widths clamped 0.8 to 1.25), and extreme shapes fall back to equal columns; in both cases tiles are never stretched, cropped or upscaled to chase a flush edge (`data-flush="false"`, `object-fit: contain`), so the bottom edge is uneven. Empty columns are not rendered. Tile shape comes from the stored `width / height`, which the agent used to record in the raw sensor frame while thumbnails are upright (a phone portrait shot got a landscape tile). `extractExifData` now reports upright dimensions (swapped for EXIF orientation 5 to 8), and for photos indexed before that `PhotoGrid` reads the thumbnail's natural size on load: when its portrait/landscape orientation disagrees with the stored size (near-square photos are skipped) the tile is re-shaped and the shape is remembered in localStorage `pixdex.thumbRatios` (`useThumbRatios`, newest 3000). A one-time reflow per such photo per browser. People has `SortIcons` too. Sort is `SortIcons` (no direction). Frontend only: no Worker CPU, D1 or API change.
- Album hero cover (`src/components/AlbumHero.tsx`, `HeroFraming.tsx`, `src/services/heroImage.ts`, `heroStore.ts`, `framing.ts`,
  styles `pdx-hero*` in `src/index.css`): when the album summary has a `coverThumbnailUrl`, the album page shows a banner under
  "All albums" on every tab (340px tall, 220px below 576px, radius 8px, cover cropped, name in the heading font and the album's
  `photoCount` in white bottom left over a gradient). The title then leaves the row below (avatars, Share, "Shared by", sort,
  columns), and that row shows a count only while a filter is active; without a cover thumbnail (or until the summary loads) the old
  header stays. The blurred thumbnail shows until the hero image does, and stays, with no error text, when there is none.
- Hero image storage (browser only, nothing on Cloudflare): the image is the cover's original file exactly as served (no resizing,
  re-encoding or size cap; the browser applies EXIF orientation, transparent areas show the banner's background), kept in IndexedDB
  database `pixdex`, store `heroes`, key: album name, record `{ album, contentHash, status, image?, updatedAt }` (content hash taken
  from the thumbnail URL), so one record per album and an old cover is overwritten. A record for the current cover with status
  `ready` is shown with no hero request. `unavailable` (network error, any non-OK status, a content type that is not `image/*`, or a
  download that goes 30 s without a byte) is tried again on every album page visit, with no back-off. `undecodable` (an image this
  browser cannot decode, such as HEIC in Chrome) is not tried again until the cover changes. No record, or another cover's:
  `GET /api/originals/:coverId` with `cache: 'no-store'`, for the owner and viewers alike. Each IndexedDB operation is bounded at
  3 s; IndexedDB missing, blocked, full or cleared (browsers may evict it) never shows an error, the image is just fetched again.
  Two mounts at once share one attempt; the query `['album-hero', name, hash]` has `staleTime` Infinity, `gcTime` 0 and
  `retry: false`. Storage grows by about one original per album visited; records of renamed or deleted albums are not cleared. A
  stored copy stays in that browser after access is revoked (the album page, the only thing that shows it, no longer loads for that
  user) until site data is cleared or the browser evicts it.
- Reposition and zoom (owner only, `canEdit`): "Reposition" appears once the sharp image shows. Edit mode: drag (mouse or touch),
  slider or pinch zoom 1x to 3x, arrows move 1% (10% with Shift), `+` and `-` zoom, "Reset" (centre, 1x), "Cancel", "Save"; the title
  is hidden, a failed save stays in edit mode with the error, and a cover change ends it without saving. Framing is `{ x, y, zoom }`
  (x, y 0 to 100), rendered as `object-fit: cover`, `object-position`, `transform-origin` and `scale` (`frameStyle`), the blurred
  thumbnail too. It is saved in `albums.cover_framing` (migration `0022_album_framing.sql`, JSON `{ hash, x, y, zoom }`, NULL for the
  centre at 1x) and applies only while `hash` is the current cover, so a new cover shows centred; going back restores it unless
  another cover was framed in between. It is lost if the album empties and its row is removed. `PUT /albums/framing`
  (`worker/src/routes/framing.ts`, `guardedWrite`; body `{ album, contentHash, x, y, zoom }`; 400 invalid or out of range, 404 not
  visible, 403 viewer, 409 not the current cover; in the Pages proxy PUT allowlist, JSON). The paged `GET /albums` returns
  `coverFraming: { x, y, zoom } | null` to owners and viewers. `dev/mockApi.ts` keeps framing in memory and serves originals as the
  generated SVG.
- Album hero performance (not measured on real Worker or D1, check with `wrangler tail`): a stored hero costs no request. Making one is
  one original view (the Function's access check, about 2 D1 rows, and one Drive call for a Drive photo), once per browser and cover;
  while unavailable that repeats on each album page visit. No image bytes pass through the Worker (the original goes Pages Function to
  originals tunnel), and the hero uses no R2. `GET /albums` reads one more column, no extra rows, plus a small JSON parse per album
  row with framing (at most 48). Saving framing is one `albums` primary-key read (`albumRole`) and one row written.
- Ignored faces (migration `0021_face_ignore.sql`, `faces.ignored_at`, NULL = not ignored). An ignored face is always `unassigned`
  with no person. Only the album owner ignores or restores: `POST /faces/ignore` and `/faces/restore` (`{ faceIds }`, 1 to 200,
  `guardedWrite`, all-or-nothing 404/403, set-based; ignore skips faces that are not unassigned; `{ ignored }` / `{ restored }` counts)
  and `GET /people/ignored?cursor=` (owned albums only, newest first, 60 per page, cursor `<ignored_at>|<rowid>`, 400 if malformed);
  all three are in the proxy allowlist. Every new face query must skip ignored faces where it would group, match or show a
  known-personality match: groups, match candidates and apply, auto-match, `knownFilterSql`, `KNOWN_COUNTS_SQL`, album known tiles
  and covers (shared viewers lose the match too; `known_id` is kept so restore brings it back). Confirming a face clears
  `ignored_at`. A rescan keeps an ignored face like a confirmed one (overlapping new face dropped, counted in `kept`, crop and
  rejections stay). Agent and ingest bodies never set it. `SerializedFace.ignored`. UI: "Ignore group" and a cross per face on the
  People page, `IgnoredFaces.tsx` (closed by default, no request until opened), "Ignore" / "Restore" on the photo's People card
  (owner only). Not covered: no negative references, so new photos of the same stranger appear as new unnamed faces.
  **Index rules (measured, do not change casually):** the migration is additive. `idx_faces_assign_status` and
  `idx_faces_known_photo` stay as they were: replacing the status index was measured to slow existing queries (the people cover
  query about 29% more rows read; with a widened index the old groups query about 240 times more). The partial indexes
  `idx_faces_ignored`, `idx_faces_open_status` and `idx_faces_known_shown` are for the new queries only: groups and the known
  list and filter pin theirs with `INDEXED BY`, and every other `ignored_at` test is written `+ignored_at` so a partial index
  cannot take over its plan.
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
- People are per owner: `persons.owner_email` is the creator. Rename, delete, cover, assign, match and name uniqueness
  (`idx_persons_owner_name_lower`, case-insensitive per owner) are owner-only (404 not visible, 403 visible but not theirs). Face
  assign, reject, unassign and adding faces need the face's album to be the caller's (`faceRoles`) and the named person to be theirs.
  `GET /people` lists the caller's people plus other owners' people with a confirmed or auto face in a photo the caller can see
  (`canEdit` marks the caller's own); `GET /people/groups` returns unassigned faces in albums the caller owns. Auto-match at ingest and
  `POST /people/:id/match` only compare people and faces of the same owner (`loadReferences({ owner })`, cached per owner).
- Person names are private to their owner: for a person the caller does not own, every response (`GET /people`, `personName` on
  `GET /photos/:id/faces` and on covers, including the list sort) carries the caller's own label or `null`, never `persons.name`.
  Resolve names only through `PERSON_NAME_SQL` in `worker/src/db/faces.ts` (a scalar subquery on the `person_labels` primary key,
  run only for rows the caller does not own); never select `p.name` raw. A viewer sets their label with `PUT`/`DELETE
  /people/:id/label` (migration `0017_person_labels.sql`: table `person_labels (viewer_email, person_id, name, created_at)`,
  unique per viewer on `lower(name)` among labels only, `idx_person_labels_person` for the delete trigger, lowercase-email triggers, `persons_labels_ad` trigger deletes labels when a
  person is deleted). 404 if the person is not visible, 400 for the owner (they use `PATCH /people/:id`), 409 on a clash.
  A label never changes matching or grants any other access. Search and timeline filter by person id, never by name.
- Background matching (frontend): naming a face or group, and Re-run matching, only enqueue the person in
  `matchQueueFor(queryClient)` (`src/services/matchQueue.ts`; the hook `src/hooks/useMatchQueue.ts` is only for components that show its state); never await `matchPersonAll`
  in a component. One person runs at a time, a person already waiting is not queued twice, progress is `MatchStatus` in `Layout`
  (with a `beforeunload` warning). After a save, `refreshAfterNaming` drops the named faces from the cached groups (no group
  refetch) and refreshes the other lists; a finished run refreshes everything only if it matched something or failed.
- Match page query (`MATCH_CANDIDATES_SQL`, `worker/src/routes/people.ts`): keep the unary `+` on `assign_status` and the
  CROSS JOINs. It must walk `faces` by rowid and stop at `FACE_PAGE_SIZE` (plan pinned in `worker/test/query-plans.test.ts`);
  through the status index every page read and sorted all remaining candidates.
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
  include `GET timeline`, `GET timeline/buckets`, `GET people/known`, `GET albums/contents` and `GET me`; also forwards the
  browser writes (JSON bodies only): `PUT albums/cover`, `PUT albums/shares`, `PUT albums/framing`, `PATCH photos/:id`,
  `PATCH`/`DELETE people/:id`, `PUT`/`DELETE people/:id/label`, and `POST` to `people`, `people/:id/faces`,
  `people/:id/match`, `people/:id/cover`, `faces/:id/assign|reject|unassign`; admin: `GET admin/requests` and
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
- `worker/` - Hono Worker: ingest + read API, D1 migrations, FTS5 search
- `agent/` - local Node/TS indexing CLI, originals server, and the `move-album` script. The originals server serves
  local files and Google Drive files (`openDriveFileStream` in `google/driveFiles.ts`, agent's stored OAuth token, lazily built, piped
  with no staging; a missing/invalid token or Drive failure is a 404; no Range support yet); the frontend uses `/api/originals/:id`
  for both sources (`src/services/originals.ts`) and the photo page shows "Open in Google Drive" via `getDriveUrl` (owner only).
  Agent-only: no Worker CPU or D1 change, one Drive API call per original view
- `agent/known/people.json` - curated known-people list (Wikidata ids, sorted by name, one object per line, at least 200
  entries); manage it only through the CLI (`known-search`, `known-add`, `known-check [--offline]`, logic in
  `agent/src/known/list.ts`), never type ids from memory; process in `agent/known/README.md`
- Known matching: `scanFaces` matches each kept face's embedding against the local gallery (`agent/.index-state/known-gallery.json`, loaded once per command by `src/known/loadKnownGallery.ts` and passed down as `gallery` / `knownGallery`; missing or corrupt means no matching, the corrupt case warns once) and posts `known: {id, score}` only for a confident match. The gallery is matched only on the agent. Its backup is one R2 object, `known/gallery.json` (same bucket binding as thumbnails), that only the agent can read or write through `PUT`/`GET /ingest/known-gallery` and `GET /ingest/known-gallery/status` (`{exists, size}`, one R2 head; ingest token, outside the Pages proxy allowlist); the Worker never parses it, streams the bytes through (64 MB cap, 413; empty body 400) and does no matching, and no D1 is touched. A gallery built with a different face model than the detection warns once per run and posts no `known`; a face with an undecodable embedding is skipped. Cost is about 3.3 ms per face on the agent machine (405 people x 10 refs), local only.
- Known agent commands (run from `agent/`): `known-search`, `known-add`, `known-check [--offline]`, `build-known-gallery [--rebuild <id>...] [--retry-excluded] [--full]`
  (writes `agent/.index-state/known-gallery.json`, uncommitted; incremental; people with fewer than 3 usable openly licensed photos are
  excluded and recorded in the file (optional `excluded` field: id and ref count) so later builds do not re-crawl them, unless `--rebuild <id>`
  names them or `--retry-excluded` is passed; `--full` ignores the existing file; Wikimedia failures are retried every run; the client sends `face-gallery-builder/0.1 (<WIKIMEDIA_CONTACT>)` when that optional env var (email or URL, `agent/.env` only, never logged or committed) is set, and paces API requests at 1.5 s with a contact or 6.5 s without (Wikimedia's 200 vs 10 requests per minute buckets, mediawiki.org Wikimedia_APIs/Rate_limits; doubling to 8 s after a 429); Wikidata claims (`wbgetentities`, 50 ids) and Commons imageinfo (50 titles) are batched, about 4 API requests per person, honours `Retry-After` on 429/503 for up to 6 attempts, then throws `RateLimitedError`; 5 rate-limited people in a row stop the build after a checkpoint (non-zero exit); only jpg, jpeg, png and webp files are crawled; downloads go through the same client),
  `known-gallery-push` and `known-gallery-pull [--force]` (explicit R2 backup: pull refuses to overwrite an existing local file without `--force`). `build-known-gallery` (unless `--full`) starts from the local file, else restores the R2 backup (validated by the same loader; a model mismatch means a full rebuild, a corrupt object warns and is ignored), builds incrementally, then pushes the saved file once at the end if the gallery changed or R2 has no backup yet (status check; a failing status call or push only warns and the build still exits 0; an R2 read error other than 404 aborts the build). `backfill-known` restores from R2 when the local file is missing. Scan commands stay local-only (no R2 traffic): on a new machine run `known-gallery-pull` (or `build-known-gallery`) once. Performance: one R2 put per build that changed the gallery (about 11 MB for 405 people x 10 refs), one R2 get on a restore, one R2 head per unchanged build (the status check), zero D1 queries, and the Worker does no JSON work (the body is streamed through, never parsed); these are Class A (put) and Class B (get) R2 operations, a handful per month.
  `backfill-known [--dry-run] [--rescore] [--page-size <n>]` (pages stored embeddings through `POST /ingest/faces/embeddings`, matches locally, writes via
  `POST /ingest/faces/known`; `--rescore` also clears matches that no longer hold and is needed after a threshold change, after removing a
  person or after `--rebuild` of one; `--page-size` 1 to 100 is the page `limit` knob). A rescan (`index-*`, `backfill-faces --recrop`) on a machine
  WITHOUT the gallery file resets known matches on the rescanned unassigned and auto faces; a normal `backfill-known` restores them. The
  committed list is validated with the Worker's limits (name 1 to 200, up to 20 aliases of 1 to 100 characters) by `known-check`. `KNOWN_THRESHOLD` 0.6 (raised from 0.5 after a dry-run on a family library matched only children at 0.50 to 0.54) and `KNOWN_MARGIN` 0.05
  (`agent/src/known/matcher.ts`) are initial guesses: tune them from `backfill-known --dry-run` before the real run. The seed list
  is 405 people; how many reach the gallery is reported by the first `build-known-gallery` and is not yet known.
- Gallery build group photos: after the single-face pass, photos with 2 to `MAX_GROUP_FACES` (12) faces contribute the one face whose max cosine over the accepted single-face refs (anchors; at least one required) is at least `GROUP_MIN_COSINE` (0.5) and leads the next face by `GROUP_MARGIN` (0.1), at most `GROUP_PHOTO_LIMIT` (15) photos per person, never beyond `MAX_REFS`; constants in `agent/src/known/buildGallery.ts`, report field `groupRefs`. Batched Wikimedia requests are chunked to `MAX_QUERY_CHARS` (6000) encoded characters plus 50 items (HTTP 414 fix). Agent-side only: no Worker CPU or D1 impact.
- `known-pick [--id <Q-id>...] [--port <n>]` (`agent/src/known/pick/`: `server.ts` pure `createPickApp` handler plus an http adapter bound to 127.0.0.1 only,
  random per-run token required on every call as `X-Pick-Token` or `?token=`, Host header checked, no CORS; `candidates.ts` gather (reuses `candidateTitles` from `buildGallery.ts`, the
  same `WikimediaClient`) plus the on-disk cache `agent/.index-state/known-pick-cache/` and a one-at-a-time crawl queue; `scoring.ts`; `page.ts` the single HTML page): manual face picker for excluded people.
  Picks are trusted (no outlier filter, warn below cosine 0.3), at least `MIN_REFS`, at most `MAX_REFS` stored, the file is written atomically (`saveGallery` now writes a temp file then renames),
  other people are never altered, a changed gallery is pushed to R2 on exit. Agent-only: no Worker route, no D1, embeddings never leave the machine (the page gets boxes, never vectors).
- Known personalities performance review (phase 1; none of the Worker costs can be measured locally, see `docs/development.md`):
  matching is agent-side only (about 3.3 ms per face, measured with a synthetic 405 x 10 gallery). Rows read and written per request:
  `POST /ingest/known-people` 0 read, up to 500 written; `POST /ingest/faces` adds one `json_each` lookup only when a face has `known`;
  `POST /ingest/faces/known` at most 200 primary-key reads on `known_people` plus at most 200 `faces` rows read and written
  (the UPDATE only writes rows whose `known_id` or `known_score` actually changes, so a rescore writes only the faces that changed and `updated`
  counts changed rows); `POST /ingest/faces/embeddings` at most `limit` (100) rows plus one `max(rowid)`, scanning at most
  5000 rowids, 0 written; `GET /people/known` 2 statements, 0 written, one index row plus one `photos` key lookup per known-matched face
  (scales with the global count of matched faces that are not ignored); the `known=` filter is one more subquery on `idx_faces_known_shown`. UNMEASURED: the
  embeddings route CPU and the D1 BLOB decode (D1 may return a number[]; `limit` at most 100 is the knob), and the backfill time, estimated
  at 1 to 3 minutes for about 5K photos: measure both with `wrangler tail` after deploy.
- Known personalities UI status: the omnibox and the Timeline `PeopleFilter` were checked in a real browser, light and dark, against the dev mock (`PIXDEX_MOCK=1 npm run dev`); the real library has no known matches yet, so real-data behaviour is unchecked.
- Drive listing (`google/driveScan.ts`, `DriveScanner`): folders are listed 6 at a time (`concurrency`), 1000 entries per `files.list` page
  (the API maximum; the default is 100), and each folder's photos are handed to `indexGoogleDriveFolder` as soon as that folder is
  listed, so indexing starts after the first list call and listing overlaps with the slow Ollama work (nothing needs the whole tree:
  the Processed rule needs one folder's full listing, `check-hashes` needs a batch, in-run dedup needs a growing set). A subfolder that
  cannot be listed (after retries) is reported (`Failed listing ...`, counted in `failed`) and the walk continues; a failing root
  throws. Progress lines: `Listing: N folders, M photos found so far` (every 5 s) and `Listing finished: ...`. `check-hashes` is sent
  per batch of up to 500 not-yet-checked checksums made of every photo that arrived since the previous batch (the first batch is one
  folder, later ones are large because indexing is slower than listing): the same rows read in total, at most about `photos / 500`
  plus a handful of extra Worker requests compared with one global call.
- `index-drive` log lines (for measuring throughput): every line starts with an ISO-8601 UTC timestamp (added in `driveCli.ts`). An `Indexed:` line
  carries the album, folder path, file size, download / index / total time, per-stage seconds (`StageTimings` from `processFile`: exif, analyze, rate, caption, hashtags, thumbnail, species, ingest, faces; stages that did not run are left out) and the running `#N`; `Skipping` and `Failed` lines carry the folder path
  and size. A `Progress:` line every 5 minutes and a final `Summary:` line give indexed / skipped / failed counts, photos per minute overall and over
  the last 20 indexed, queued vs found photos, folders listed, elapsed time and an upper-bound ETA for the queued photos (some will be skipped, and
  the listing may still be running). Agent-only: no Worker CPU or D1 change.
- Drive selection rules (`scanDriveFolder` in `google/driveScan.ts`, per folder, after all its listing pages): a folder with a `Processed`
  subfolder (case-insensitive) contributes only that subfolder (its own photos and other subfolders are ignored), otherwise its own photos
  plus every subfolder, recursively; camera RAW (`isRawFile`: extension list or `image/x-<vendor>` mime) is always ignored. The
  `index-drive` folder search shows each result's parent name (one `get` per distinct parent, at most 50, failures only lose the hint).
- `index-drive --dry-run` (`google/dryRunDriveFolder.ts`): directory-tree report with per-folder counts and what was ignored, no download, no Ollama, no sidecar, no writes; one
  read-only `check-hashes` per 500 advertised checksums (a failure only warns). Worker CPU and D1: no change beyond those reads.
- Google Drive indexing (`agent/src/google/`, `agent/src/driveCli.ts`, command `index-drive [--dry-run] [--folder <id-or-url>]...`): recursive over
  subfolders, includes shared drives (`corpora: 'allDrives'`, `supportsAllDrives`), album from `albumFromDrivePath`
  (the first folder under the picked one, so deep trees with generic leaf names like "001" or "FB" do not merge albums; differs from local
  `albumFromPath`), skips folders matching `DEFAULT_EXCLUDED_FOLDERS` (`*.lrdata`, `*.aep`, `Adobe After Effects Auto-Save`, `(Footage)`,
  `*_AME`, `allresources`, `*.collagefactoryfree`) plus any `--exclude <glob>` (never a Processed folder), skips already-indexed photos by Drive's `sha256Checksum` (equals `sha256ContentHash`) with one batched
  `check-hashes` before any download (files without a checksum are downloaded and checked as before), skips in-run duplicate content,
  retries 429, rate-limit 403, 5xx and network resets (`withDriveRetry`), and on `invalid_grant` deletes `agent/.google-token.json`
  and exits 1. Local storage (`google/staging.ts`): the current photo plus the prefetched next one (at most two) staged in `<tmpdir>/pixdex-drive-staging`, each deleted after its photo
  A file over `DRIVE_STAGING_MAX_MB` (optional env, default 1024) is refused before download (listing `size`) and again after
  (actual size); `pixdex-drive-*` files older than 1 hour are swept at the start of each run (orphans of a killed run). Agent-only: no Worker route, CPU or D1 change (the Worker sees the same `POST /ingest/photo`; fewer `check-hashes`
  calls per file, now one per 500 photos plus one per checksum-less file).
- Indexing overlap (`processFile.ts`, `google/indexGoogleDriveFolder.ts`): the face and species sidecar calls start right after EXIF and run while the
  vision model works (they need only the picture and the region; `detectSpecies` is the sidecar half of `identifySpecies`, `decideSpecies` runs after
  `analyze` because its animal cue needs the model's subjects; `scanFaces` takes the started `detection` promise). Their stage seconds overlap
  `analyze`, so the stage times on an `Indexed:` line can add up to more than the total. `index-drive` also downloads and hashes the next photo of the
  batch while the current one is indexed (the `download` seconds are then hidden behind the previous photo; `total` is the wall time from taking the photo
  to finishing it). A failed prefetch is reported against its own photo. Agent-only: no Worker route, CPU or D1 change; the sidecars now share the
  machine with Ollama while it works, so `analyze` can run a little slower.
- Thumbnail orientation (`agent/src/thumbnail.ts`): new thumbnails are stored upright (`.rotate()` applies the EXIF orientation, sharp drops the tag),
  so phone photos are no longer sideways. Thumbnails indexed before this change are still in the raw sensor frame and are left as they are. Face boxes
  must be in the same frame as the photo's thumbnail (the UI draws them over it): `scanFaces(..., { boxFrame })` is `upright` from `processFile` and `raw`
  (the default) from `backfill-faces`, so a post-change photo whose scan was missed at index time gets raw boxes from `backfill-faces` (wrong for a rotated
  photo; re-index it instead). Agent-only: no Worker route, CPU or D1 change; one extra in-memory rotate per thumbnail.
- `agent/sidecar/` - local Python InsightFace service (face detection and embeddings), see its README
- Species identification (optional, `SPECIES_SIDECAR_URL`, `agent/sidecar/species_server.py`: BioCLIP 2.5 Huge in fp16 on the whole frame plus an OWLv2 bird detector, about 3 GB resident, loopback only, `requirements-species.txt`, no virtualenv; the species text embeddings are computed once per region with the model's own text encoder and cached as `agent/.index-state/species-regions/<region>.bioclip-2.5.v2.npz`; region species GBIF names the model's older taxonomy lacks are resolved through GBIF synonyms once at that build; the 0.5 thresholds were tuned on BioCLIP 2 scores and not re-tuned for 2.5): the vision model names birds badly, so `agent/src/species/` decides
  (`decide.ts` `decideSpecies`: whole-frame answer for non-birds, bird boxes for birds, each species once with its best score, a second animal in a photo is kept, score below 0.5 dropped; a whole-frame answer below 0.9 also needs a sign of an animal in the vision model's subjects (`cue.ts` `hasAnimalCue`: an animal word, or the last word of the predicted name), because the whole-frame answer is relative and always names the closest animal, so people and scenery photos got mid-confidence toads and turtles; bird boxes are exempt; thresholds from a labelled evaluation, change them only with new evidence),
  resolves the region (`regions.ts`, committed `agent/species/regions.json`: EXIF position box, else album-name pattern, else the default; GBIF lists from `build-species-regions` in the uncommitted `agent/.index-state/species-regions/`; only region names go to GBIF) and shares `identifySpecies` (`identify.ts`) between indexing and the backfill. Stored in `photos.species` (JSON `[{common, scientific, score, box?}]`) and `photos.species_model` (NULL until scanned, set even when nothing was found), migration `0020_species.sql`; `subjects` is never written with species (the ingest upsert overwrites it). The names are indexed in `search_primary` (bm25 weight 4) and `search_text` via `speciesWords` (`worker/src/db/photos.ts`), and NOT indexed when the owner has set `user_subjects` (their words win; species stay stored and shown). `POST /ingest/photo` takes optional `species` and `speciesModel` (absent keeps the stored ones). Worker routes, ingest token only and out of the proxy allowlist: `POST /ingest/species` (up to 100 photos by content hash; one SELECT by the unique hash index, one batched UPDATE per photo with the search text rebuilt from the row, so repeats never pile up), `POST /ingest/species/pending` (rowid cursor, at most 100, local and Google Drive photos with `species_model` NULL or different, optional `album`) and `POST /ingest/species/summary` (per album total and pending, one pass over `photos`, for `--list`).
  `backfill-species [--list] [--dry-run] [--album <name>]... [--limit <n>]` is driven by D1 like `backfill-faces` (no folders): pending photos come from the Worker, local files are read by path, Google Drive files through the stored login only (`species/driveReader.ts`, never opens a sign-in, `DRIVE_STAGING_MAX_MB`, in memory), results are written in batches of 25; a missing file or a Drive photo without a login stays pending, five failures in a row stop the run. Performance: Worker CPU is a short JSON parse and string build per photo (no embeddings, no loops over table size); D1 per `POST /ingest/species` of 100 photos: about 100 rows read by the unique `content_hash` index, 100 rows written plus the FTS rewrite per photo (UNMEASURED locally: run `--limit 200`, then `wrangler d1 insights`); `pending` reads about one photo row per photo scanned over a full pass (rowid scan, like faces unscanned); `summary` is one pass over `photos`, only for `--list`; search and timeline queries are unchanged apart from slightly longer `search_text` and `search_primary`. Agent time is about 3 to 5 seconds per photo.
- `docs/` - internal docs, plus `superpowers/` plans and specs and `screenshots/`
  (README images made from dummy data: gradient placeholders, no real photos or people)

## Commands

Root, `worker/`, and `agent/` are separate npm packages.

- Frontend: `npm run dev` (`PIXDEX_MOCK=1 npm run dev` serves dummy data from `dev/mockApi.ts`: dev only, needs no `.env` or secrets, never in the build), `npm test`, `npm run lint`, `npm run build`
- Worker: `cd worker && npm test && npm run typecheck`
- Agent: `cd agent && npm test && npm run typecheck`
- Face sidecar (Python, optional): `pip install -r agent/sidecar/requirements.txt`, then
  `python3 agent/sidecar/server.py` (no virtualenv; use a Python 3.11 or 3.12 that has pip).
  InsightFace weights are non-commercial, personal use only.

A pre-commit hook runs the suites touched by staged changes; do not bypass it.

## Deployment

Pushing to `main` deploys both the frontend (Pages) and the Worker via
Cloudflare's GitHub integration. There is no CI test gate, so verify locally first.
The Worker build deploy command is `npx wrangler d1 migrations apply DB --remote && npx wrangler deploy`,
so pending D1 migrations are applied automatically on merge, before the new code goes live.
Keep them additive; for a destructive one, take a Time Travel bookmark first. Details in `docs/development.md`.

## Rules

- Never expose `READ_TOKEN`, `INGEST_TOKEN` or `ORIGINALS_TOKEN` to the browser;
  no `VITE_` prefix on secrets.
- `/ingest/*` must stay out of the Pages proxy allowlist.
- Owner edits (`user_*` columns) are never written by the agent or ingest
  routes; ranking uses `worker/src/db/rating.ts` (combined score), not
  `aesthetic_score` directly.
- `faces.person_id`, `faces.assign_status` and `faces.ignored_at` are owner/Worker decisions: the agent
  and ingest request bodies never set them (unknown keys are dropped). The Worker's
  own matching only ever writes `auto`; `confirmed` comes from the owner via the
  browser writes. Rejections live in `face_rejections`.
- In `worker/`, import zod as `import * as z from 'zod/mini'` (functional API, `z.flattenError(err)`), never from
  `'zod'`: the classic build adds about 450 KiB to the Worker bundle. `agent/` may use classic `zod`.
- DB changes go in a new numbered file in `worker/migrations/`.
- `albums` and `counters` are derived by triggers (`worker/migrations/albums.ts` generates
  `0015_albums.sql` via `cd worker && npm run gen:albums-migration`). Never write them from route code; change
  the generator and add a new numbered migration. Exception: the owner-edited `albums.owner_email`,
  `albums.shared_with` (migration `0016`) and `albums.cover_framing` (migration `0022`) are not derived. Only
  `PUT /albums/shares`, the first-photo stamp in `POST /ingest/photo` and the one-time
  `worker/scripts/backfill-owner.mjs` write the first two; only `PUT /albums/framing` writes `cover_framing`.
- After every feature or change, update `README.md` and this file (and `docs/`
  if architecture, config or workflow changed) in the same commit.
- Known personalities (phase 1, migration `0018_known_people.sql`: table `known_people (id Wikidata Q-id, name, aliases JSON, created_at)`,
  `faces.known_id`, `faces.known_score`, partial index `idx_faces_known_photo (known_id, photo_id) WHERE known_id IS NOT NULL`). A known
  match is a suggestion ("looks like"), never a claim of identity: it never sets `person_id` or `assign_status`, is independent of them,
  and a kept confirmed face keeps its own values. Matching runs only on the agent (cosine against the local gallery); the Worker never
  loops over embeddings to match. Worker routes: `POST /ingest/known-people` (agent upsert, 1 to 500 people, one `json_each` statement),
  `POST /ingest/faces/known` (set or clear up to 200 matches, `knownId: null` clears, unknown id is a 400 for the whole request),
  `POST /ingest/faces/embeddings` (backfill page of raw embedding bytes, `limit` at most 100, scan window of 5000 rowids, follow the
  `X-Next-Cursor` header), all ingest-token only and out of the proxy allowlist.
- `POST /ingest/faces` accepts a nullable, optional `known: { id, score }` per face (agent-computed match; null or absent means no
  match); ids missing from `known_people` are dropped (one `json_each` lookup, only when a face has `known`). Stored in
  `faces.known_id`/`known_score`.
- `GET /people/known` (`worker/src/routes/known.ts`, READ_TOKEN plus `X-Viewer-Email`, in the Pages proxy allowlist) lists known
  personalities with at least one matched face in a photo the viewer can see (`scopeFor`), `photoCount` = distinct visible photos. One
  grouped aggregate over `idx_faces_known_shown` (faces pinned as outer table with CROSS JOIN) plus one `json_each` name lookup. Its
  read cost scales with the global count of known-matched faces (index walk, scope filtered after), not with the viewer's photos.
- `known=<Q1,Q2>` on `/search`, `/timeline` and `/timeline/buckets` (`worker/src/db/known.ts`: `parseKnown`, `knownFilterSql`) is an AND
  filter: the photo needs a face matched to every id (with or without a person). It shares the cap of 5 with `people` (people take slots
  first, extra known ids are silently dropped, never a 400), ids are bound, and the subquery walks `idx_faces_known_shown`; an unknown id is just zero results.
- Album page People and Species tabs (`src/components/AlbumPhotos.tsx`, tiles `AlbumTiles.tsx`, chip `AlbumFilterChip.tsx`, URL logic `src/services/albumFilter.ts`): tabs Photos, People and Species (the last two only when the album has any); `tab=people|species` (absent is Photos). Picking a tile sets one filter and returns to Photos with the page reset. URL params `people`, `known`, `species`: ONE filter at a time, precedence people, then known, then species, the rest dropped (`parseAlbumFilter`; people and known use the first id, species is one scientific name); a chip above the grid shows and clears it (for a people filter on a person the user created, `canEdit`, the chip also links "View all photos of <name>" to `/people/<id>`; never for known, species, a person the user does not own, or before the contents load). With a filter active and no results the page says "No photos in this album match this filter." ("This album has no photos." only without a filter). Tab content renders inside `Tabs.Panel` (only the active panel is mounted). The filter feeds the existing `GET /search` (`album` plus `people` / `known` / `species`). Species are green (`SPECIES_COLOR` in `chipStyle.ts`, `--pixdex-ink-green` in `index.css`) beside blue own, violet known and teal album. `dev/mockApi.ts` serves `GET /albums/contents` and the `species=` filter.
- `GET /albums/contents?name=<album>` (`worker/src/routes/album-contents.ts`, READ_TOKEN plus `X-Viewer-Email`, in the Pages proxy allowlist): `{ people: [{id, name, canEdit, photoCount, cover}], known: [{id, name, photoCount, cover}], species: [{scientific, common, photoCount, coverPhotoId, thumbnailUrl}] }`. Each list is capped at 200 (`MAX_TILES`), sorted by `photoCount` descending then name (case-insensitive); `photoCount` is distinct photos in the album. People count only `auto` and `confirmed` faces. Scoped by `scopeFor` (404 for an album the viewer cannot see, 400 for an empty or missing `name`; the name is never trimmed, so a padded album name matches only itself). Name privacy: person names resolve only through `PERSON_NAME_SQL`, so a person the viewer does not own shows the viewer's own label or `null` (the UI shows "Unnamed"), never `persons.name`. Ties in count and name break on the person or known id, so the order is stable. Cover faces come from a window function (one per person or known id, no per-tile query; the inner query keeps only keys and ranking columns and `PERSON_NAME_SQL` runs once per kept cover in the outer SELECT, never per face row); the species cover is the photo with the best score. The viewer's query key is `['album-contents', name]`, `staleTime` 5 minutes, fetched once the photo list has loaded.
- `species=<scientific name>` on `GET /search` (`worker/src/db/species.ts` `speciesFilterSql`): photos whose `species` JSON lists that scientific name (name always bound, 200 characters at most, blank ignored, the JSON is wrapped in `CASE WHEN json_valid(...) THEN ... ELSE '[]' END` and non-object elements are ignored, so malformed JSON never matches and never errors); it combines with `album` and the other filters by AND, and counts as a filter for the unfiltered-total shortcut.
- Album contents performance review (UNMEASURED on real D1): one request per album page view (cached 5 minutes in React Query), one `DB.batch` of 6 statements, 0 written. Rows read: the visibility check (albums primary key) plus the album's photos (`idx_photos_album_cover`) and about 4 passes over the album's faces (people counts, known counts, two cover windows; `idx_faces_photo_id`, `persons` / `known_people` primary-key joins; the `person_labels` probe for a person the viewer does not own runs once per people-count row and once per kept cover, at most 400 probes, not once per face row) plus one pass over the album's photo rows for species; `json_each` over `photos.species` runs inside D1, not the Worker. `EXPLAIN QUERY PLAN` (in `worker/test/query-plans.test.ts`) shows no SCAN of `photos` or `faces`. Worker CPU is only mapping at most 200 tiles per list plus at most 400 cover rows. The `species=` filter on `/search` reads the album's photo rows once more for the rows and once more for the COUNT (a `json_each` per candidate photo). Measure after deploy with `wrangler tail` and `wrangler d1 insights` (worst case: an album with thousands of faces, and species filtering in a big album). If big albums are slow, the fallback is a `photo_species (photo_id, scientific, common, score)` table (approach 2 of `docs/superpowers/specs/2026-11-20-album-people-species-design.md`) filled at ingest and the species backfill, so counts and the filter use an index instead of `json_each`.
- Search omnibox (`src/components/omnibox/`): the bar shows album, own-people (blue), known (violet, "known" marker) and date chips; typed words
  become suggestions through the shared matcher (`src/services/omnibox/matcher.ts`: debounce 150 ms, from 3 characters per span, each word
  matches anywhere inside a name or alias word, case and accent insensitive, no fuzzy matching, longest span wins, a person never used twice,
  at most 3 ambiguous chips per span plus "+N more", an option that replaces the chips with a scrollable list of every match for that span, headed "Matches for <words> (N)"; typing, blur, Escape or a pick closes it, and it uses only the already loaded lists, so no extra request); typing alone never filters; Enter is a plain search, "Ask AI" / Cmd+Enter only where the
  Prompt API exists. "Add both" (shown for two person spans, only if the cap of 5 allows) carries the real count from one `GET /search?limit=1`
  per distinct set of top matches after each 150 ms pause in typing, cached by ids and filters, never per keystroke. Binding rules:
  `onSelection(patch, nextText?)` is ONE URL update per pick (never two in a row), and the trimmed text is written to `q` only when the
  box held the submitted `q` (otherwise only the box is trimmed, so leftover typing is never searched); in AI mode every chip change
  re-runs the whole pipeline (no extra calls per run); while any people or known chip is active the "Hide people photos" switch is not rendered and the
  pipeline gets `hidePeople: false` (the URL value is kept); the AI library-total call receives the same filters as the keyword calls
  (`AiFilters`: album, people, known, from, to, onThisDay) with no extra calls; album is one at a time and album suggestions hide while one is chosen;
  colours come only from `chipStyle.ts` (`OWN_COLOR`, `KNOWN_COLOR`, `ALBUM_COLOR`) and the `--pixdex-ink-*` variables.
- Frontend People filter: Timeline renders `src/components/PeopleFilter.tsx` (Search now uses the omnibox above; one Mantine `MultiSelect`, values `p:<id>` own
  and `k:<id>` known, groups "Your people" then "Known personalities in your photos", own entries blue and known violet with a "known"
  marker so colour is not the only signal; `renderPill` styles picked tags). It loads `['people']` and `['known-people']` itself
  (staleTime 5 minutes, so one extra `GET /people/known` per page load), matches locally with `matchesQuery` over name plus aliases
  (no request per keystroke; typing alone never filters; each typed word matches anywhere inside a name word, so "esh" finds "Ganesh"; from 3 characters only ("m" shows nothing, "man" finds "Rahman"; an empty box lists everyone); a list that has not loaded yet has its ids carried through unchanged), shows when either list is non-empty, caps at 5 combined and drops ids in neither
  list. URL params `people` and `known` are parsed by `src/services/peopleSelection.ts`; changing either resets the page (Search and Timeline).
- `GET /albums/contents` and the `species=` filter are read-only (no migration, no writes). Person names there come only from `PERSON_NAME_SQL`; never select `p.name` raw. The album page allows one filter at a time (people, known, species).
- Do not commit `.env`, `credentials/`, or `agent/.index-state/`.

## Performance review is mandatory (CPU and DB)

Every change, feature or fix MUST explicitly review and optimize for Worker CPU
and D1 usage, and the result must be stated in your plan and your summary. This
is not optional and not only for "performance tasks".

- Worker CPU: the free plan allows 10 ms CPU per invocation. Flag any new loop
  over embeddings, JSON parse or stringify of large payloads, base64 or blob
  decoding, per-item allocations, or work that scales with table size. Bound it
  (page size, budget, cache) or move it off the Worker.
- D1: state the rows read and written per request. Check that new queries use an
  index (`EXPLAIN QUERY PLAN`), avoid unbounded scans, `OFFSET` paging,
  `COUNT(*)` on every request, and N+1 query patterns. Prefer set-based
  statements and `json_each` batching. New indexes and tables go in an additive
  numbered migration.
- If a change adds cost, say how much and why it is worth it. If it cannot be
  measured locally, say so and list how to measure it (`wrangler tail`,
  `wrangler d1 insights`, see `TODO.todo` and `docs/development.md`).
- Do not ship a change that raises CPU or rows read on a hot path without
  telling the user first.

## Instruction files

`CLAUDE.md` contains only the `@AGENTS.md` import. Put every project instruction, rule and note in this file, and
never add content to `CLAUDE.md`.

## Docs

- [Architecture](docs/architecture.md): components, data flow, config and secrets
- [Development guide](docs/development.md): commands, hooks, deploys, conventions
- [README](README.md): setup, batch indexing, originals tunnel
- [Original design spec](docs/superpowers/specs/2026-09-18-pixdex-local-cloud-redesign-design.md)

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.
