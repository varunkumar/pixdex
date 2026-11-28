# Architecture

PixdeX is a browse and search UI for a personal photo collection. Original
photos are never stored on Cloudflare: they stay on local disk or Google Drive and
are fetched on demand (viewers' browsers keep a copy of album cover originals).
Only derived data (metadata, captions, ratings and thumbnails) is stored in the cloud.

```
Your Mac
  ├─ Ollama (vision + text generation, local)
  ├─ agent/sidecar/  (Python InsightFace service: face detection + embeddings, optional)
  ├─ agent/  (Node/TS CLI: index photos, serve originals)
  └─ cloudflared tunnel (originals on demand only)

Cloudflare
  ├─ worker/    Hono Worker: ingest + read API
  ├─ D1         photo metadata + FTS5 search index
  ├─ R2         thumbnails, face crops, known gallery backup
  └─ Pages      src/ (React UI) + functions/api (same-origin proxy)
```

Browsing and searching never needs the Mac: it is served from D1/R2. The Mac is
needed only to run an indexing pass or to fetch a full-resolution local original.
Drive-sourced photos deep-link to Drive and need no tunnel.

Original design rationale: `docs/superpowers/specs/2026-09-18-pixdex-local-cloud-redesign-design.md`.

## Components

### `src/` - frontend (React 19, Vite, Mantine, TanStack Query, react-router)

- `components/` - Timeline (day/month/year zoom via Ctrl+wheel or pinch, state in the URL; a zoom change away from the newest month writes `to` = end of the active month in the same replace navigation, so the period being read is kept, year/month scrubber rail with a floating month label while dragging, year labels thinned to at least 12px apart, a "Back to latest" chip after a jump, and Retry buttons for a failed first or next page), Search (one omnibox, `components/omnibox/` plus `hooks/useOmniboxData.ts` and `services/omnibox/`: chips for album (`album`), own people (`people=<id>,<id>`) and known personalities (`known=<Q-id>,...`), cap of 5 combined; typed words are matched locally after 150 ms from 3 characters and only become chips when picked; "Add both" count from one `limit=1` search; Enter is a plain search with `q`; date range picker, quick chips and an "On this day" chip in the URL as `from`, `to`, `onThisDay`; typed dates such as `june 2025` parsed by `services/dateQuery.ts`), Albums, AlbumPhotos, PhotoDetail, PhotoReview (stars
  and AI overrides), PhotoFaces/FaceTile (name and correct faces on the photo
  page), People (`/people`: named people plus unnamed face groups to name) and
  PersonPage (`/people/:id`: photos sorted newest/best rated/alphabetical via `sort`, rename/delete, suggestion review, re-run
  matching), Dashboard,
  DailySuggestion, Lightbox, PhotoGrid/PhotoTile/MasonryGrid (masonry, see Photo grids below), AlbumCard (the classic card), SortIcons, ColumnsToggle, Layout. AdminAccess (admin only, /admin/access). Timeline keeps `PeopleFilter`.
- Photo grids (frontend only, no Worker or D1 cost): `components/MasonryGrid.tsx` deals tiles into the shortest of N columns from each photo's
  `width / height` (`components/masonry.ts`: `photoRatio` falls back to 4/3 and clamps to 0.4 to 3, `assignColumns`); N is 2 below 576px
  (1 or 2 by the phone toggle, `hooks/usePhoneColumns.ts`, localStorage `pixdex.phoneColumns`), then 3, 4 (992px) and 5 (1408px).
  `PhotoTile.tsx` always renders both a hover overlay and a one-line caption; CSS (`@media (hover: none)`, classes `pdx-*` in `index.css`)
  shows the overlay on hover-capable devices and the caption line on touch devices. `PhotoGrid` takes `badges` (always-visible status, top left), `actions` (corner controls, outside the
  link), `note` (AI results) and `showAlbum` (Search). Owner actions stay gated as before. Album and person owners see the same "Set as cover" icon or "Cover"
  badge. A person owner also sees a "Photo actions" menu on an automatic match. The albums page keeps the classic `AlbumCard` (cover, name, count, date, avatars, Share) with `SortIcons`. Page sizes are exactly the selector's value. `MasonryGrid` balances the columns and sets each column's width from its height (`columnGrow`), so every column ends on the same line without cropping when the page has enough photos and the widths stay moderate (otherwise tiles keep their own shape and the bottom edge is uneven, never stretched); photo columns are 1 or 2 on a phone, then 3 and 4.
  Sort controls are `SortIcons` (icon group from 576px, one menu button below; no direction control, the API has none).
- AI Search (part of Search: `components/Search.tsx`, `components/AiResults.tsx`, `services/aiSearch/`, `hooks/usePromptApiSupport.ts`): runs
  entirely in the browser and only exists where Chrome's Prompt API (Gemini Nano) is available ("Ask AI", Cmd+Enter and the plain-mode "Add keywords" button, which opens the keyword row without the model,
  are gated on it; in AI mode the page button is "Search again", which commits a typed keyword draft and re-runs the keywords without the model, while Enter in the bar stays a plain search; there is no nav entry, and `/ai-search` is a redirect, `LegacyAiRedirect.tsx`, to `/search?mode=ai`). It uses only existing read routes through the existing proxy (`GET search` and thumbnail reads):
  no new allowlist entries and no Worker, D1 or agent change. URL state: `mode=ai`, `q`, `kw`, `hidePeople=0`,
  `room=0`, plus the shared filters `album`, `people`, `known`, `from`, `to`, `onThisDay`. Pipeline (unchanged except filters): (1) the Prompt API expands the phrase into keywords (`promptApi.ts`);
  (2) one `GET search` per keyword (sorted by rating, 100 per keyword) plus a library total, all carrying the active filters;
  (3) photos are scored by rarity-weighted keyword match, each hit adding `log(libraryTotal / keywordTotal)`,
  (`ranking.ts`); (4) optionally drop people photos, using stored
  `subjects` and `tags` matched against a word list (not face data); (5) the top 150 candidates are
  kept, the keyword score is normalised to the best of those (`renormalize`), and, if "leave room for text" is on, each thumbnail is measured in a canvas for calm empty space
  (`textSpace.ts`); (6) final score = 1.0 x keyword + 0.6 x empty space (when enabled) + 0.15 x rating/10,
  and the top 48 are shown (`pipeline.ts`).
- Album hero (`components/AlbumHero.tsx`, `HeroFraming.tsx`, `services/heroImage.ts`, `heroStore.ts`, `framing.ts`): the
  album page banner shows the cover's original file, unmodified, with a blurred thumbnail until (or unless) it can. Each
  browser keeps one record per album in IndexedDB (database `pixdex`, store `heroes`, key: album name; content hash,
  status, image). `ready` for the current cover needs no request; `unavailable` (network error, non-OK status, non-image
  content type, or 30 s without a byte) is retried on every album page visit; `undecodable` (such as HEIC in Chrome) is not
  retried until the cover changes. A stored image that fails to show is rewritten as `unavailable`, so the next visit
  fetches it again. A missing record or another cover's means one `GET /api/originals/:coverId`
  (`cache: 'no-store'`), for owners and viewers. Each IndexedDB operation is bounded at 3 s and a failing, full or cleared
  store only means fetching again. No size cap; storage grows by about one original per album visited, and a stored copy
  outlives revoked access in that browser (the album page, which alone shows it, no longer loads). The owner can reposition
  and zoom (drag, pinch, slider, keys; `{ x, y, zoom }`, x and y 0 to 100, zoom 1 to 3), saved for everyone (see
  `PUT /albums/framing`) and rendered with `object-fit: cover`, `object-position`, `transform-origin` and `scale`.
- `services/api/WorkerApiClient.ts` - the only place that talks to the backend (the hero download above is the exception).
  It calls same-origin `/api/*`.
- `hooks/useListParams.ts` - sort/page state kept in the URL so listings are
  linkable and "back" returns to the same sort and page. Its `update` is
  stable and always reads the latest URL, so a memoized `onPage` never drops `sort`. It also carries `location.state` through every
  update. In-page back links use `BackLink` with `useRememberAddress` / `useLastAddress`.
- `types/api.ts` - API response types shared by components.
- Date pickers use `@mantine/dates` and its `dayjs` peer dependency.
- Tests sit next to code in `__tests__/`; helpers in `src/test/`.

### Identity and album access

Invite-only: Access is configured to allow only the group `pixdex-approved`, so a stranger never reaches the Function or Worker. A
public request-access flow feeds the admin: `GET /enroll` (self-contained page with Turnstile) and `POST /api/enroll` (Turnstile, 4 KB cap,
no Access JWT; an Access Bypass application covers exactly these two paths) forward to the Worker `POST /enroll` (READ_TOKEN bearer only,
rate limit `ENROLL_LIMITER` 5 per minute per IP, pending cap 200, always 202) which inserts into `access_requests`
(`pending`, `approved`, `denied`, `revoked`). The admin (`ADMIN_EMAIL`) lists and decides at `/admin/access` through `GET /admin/requests`
and `POST /admin/requests/:id/approve|deny|revoke`; approve and revoke edit the Access group and revoke sessions through the Cloudflare API
(`worker/src/cf/accessApi.ts`, `CF_API_TOKEN`). Album sharing alone does not grant login. Details and rollout in `docs/development.md`.

Cloudflare Access sits in front of the Pages site and, after login, adds a signed JWT (`Cf-Access-Jwt-Assertion`).
The Pages Function (`functions/_lib/access.ts`) verifies it (RS256 signature against the team JWKS at
`https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`, cached per isolate for an hour; `aud` must be `ACCESS_AUD`;
`exp`/`nbf` checked) and sends the verified, lowercased email to the Worker as `X-Viewer-Email`. It never trusts a
plain email header and drops any client-sent `X-Viewer-Email`. No valid JWT gives 401; a missing `ACCESS_TEAM_DOMAIN` or
`ACCESS_AUD` gives 500 (fail closed). The Worker requires READ_TOKEN and `X-Viewer-Email` on every read and write.

Access model (`worker/src/access.ts`, `worker/src/db/visibility.ts`): there is no default owner. `albums.owner_email` is the
album's owner; `albums.shared_with` is a JSON array of lowercase emails or NULL (migration `0016`). A user sees an album when
they own it or are in `shared_with`. An album with a NULL owner, and any photo with no album, is visible to nobody until the
one-time `worker/scripts/backfill-owner.mjs` stamps the albums (and people) with the owner address. Photo reads (search,
timeline, buckets, albums, photo, faces, daily pick) are always filtered by that scope (`scopeFor` or the primary-key join in
`photoAccess`; there is no unscoped fast path); an invisible resource is 404, and a viewer's write is 403. `PUT /albums/shares`
(owner only) replaces `shared_with`; `GET /me` returns `{ email, admin }` (`admin` is true only for `ADMIN_EMAIL`, no D1). The Worker never reads `OWNER_EMAIL`: the agent sends
it as `ownerEmail` with each ingested photo (`POST /ingest/photo`), and the first photo of an album stamps the album's owner.

People are per owner (`persons.owner_email`, unique name per owner). A person is editable only by its owner; face assign,
reject and unassign need the face's album to be the caller's and any named person to be theirs. `GET /people` returns the
caller's people and other owners' people with a visible assigned face (`canEdit` per person); groups and match candidates
only cover faces in albums the caller owns, and matching never crosses owners (references cached per owner).

Person names are the owner's private labels. Every route that returns a person name resolves it for the caller through
`PERSON_NAME_SQL` (`worker/src/db/faces.ts`): the owner gets `persons.name`; anyone else gets their own row from `person_labels`
or `null` (the UI shows "Unnamed person"). This covers the `GET /people` list and its sort, face covers and `personName` on
`GET /photos/:id/faces`; search and timeline filter by person id only, so a name can neither be matched nor leaked. A viewer
sets or clears their label with `PUT`/`DELETE /people/:id/label` (404 invisible person, 400 for the owner, 409 on a clash,
body `{ name }` trimmed 1 to 80 characters). Data model (migration `0017_person_labels.sql`, additive):
`person_labels(viewer_email, person_id, name, created_at)`, primary key `(viewer_email, person_id)`, unique index
`(viewer_email, lower(name))`, lowercase-email triggers, and an `AFTER DELETE ON persons` trigger that removes the labels.
Uniqueness is among a viewer's labels only: a label may equal the name of a person they own.

Originals: for every user, including the album owner, the Function first calls Worker `GET /access/photo/:id`
(READ_TOKEN plus their email); only a 204 is proxied to the agent tunnel, anything else is 404.
Thumbnails: one `content_hash` lookup joined to the album by primary key per request (the browser caches them for a year).
Single-photo reads use that join (`photoAccess`), list reads use the album subquery (`scopeFor`).
Viewers get `path` and `driveFileId` as null in photo responses (the owner's local path and Drive id are owner-only).

### `functions/api/[[path]].ts` - Pages Function proxy

Same-origin read proxy. Verifies the Access identity first (above). Adds `READ_TOKEN` server-side so it never ships in the
bundle. Only an allowlist of read routes is forwarded (`search`, `timeline`, `timeline/buckets`, `albums`,
`daily-pick`, `photos/:id`, `photos/:id/faces`, `thumbnails/:hash`, `faces/:id/crop`, `people`,
`people/groups`, `people/ignored`, `people/review-queue`, `people/:id/auto-faces`, `people/:id/faces`, `people/known`, `albums/contents`, `insights/:name`, `me`, `admin/requests`) plus `originals/:id`, which goes
to the agent through the tunnel. `/ingest/*` is deliberately not reachable. The public
`functions/enroll.ts` and `functions/api/enroll.ts` sit beside it and skip the Access JWT check (see Identity above).
Thumbnails are cached immutably (content-hash addressed); originals and face crops are cached
privately for a while, other routes use `no-cache`. The only writes the browser can make are `PUT albums/cover`,
`PUT albums/shares`, `PUT albums/framing`, `PATCH photos/:id`, `PATCH`/`DELETE people/:id`, `PUT`/`DELETE people/:id/label`,
and `POST` to `people`, `people/:id/faces`, `people/:id/match`, `people/:id/cover`, `people/:id/auto-faces/review`, `faces/:id/assign|reject|unassign` and
`admin/requests/:id/approve|deny|revoke` (bodies JSON only; DELETE has none), all forwarded with the read token through
one shared helper with per-method allowlists.

### Human review (HITL)

Migration `0007_user_overrides.sql` adds `user_rating` (1-5), `user_caption`,
`user_subjects` and `user_tags` (NULL = no override). `PATCH /photos/:id`
(`routes/photos.ts`) sets them and rebuilds `search_text` from the effective
values (`db/photos.ts` `searchTextForRow`). `serializePhoto` returns the
effective `subjects`/`tags`/`shortCaption` plus `userRating`, `combinedScore`
and `overrides`. `/ingest/photo` upserts never touch the `user_*` columns and
index the override when one exists. `db/rating.ts` holds the blend
(`0.7 * stars*2 + 0.3 * aesthetic`, or aesthetic alone) as SQL and TS; search
`sort=rating`, album average rating and the daily pick all use it.

The daily pick (`worker/src/routes/daily-pick.ts`) is for nature, wildlife and
landscapes: photos whose subjects or description mention a person are never
picked (text match, since the index has no people field). The pick avoids the
album of the most recent pick (falling back to it only if no other album has a
candidate). It returns 404 if no photo qualifies.

### `worker/` - Cloudflare Worker (Hono, D1, R2)

- Routes in `src/index.ts`. Ingest routes (`/ingest/*`) require `INGEST_TOKEN`;
  read routes require `READ_TOKEN` (`src/auth.ts`).
- `routes/framing.ts` - `PUT /albums/framing` `{ album, contentHash, x, y, zoom }` saves how the album cover sits in
  the banner. Guarded write, owner only (404 not visible, 403 viewer), 400 invalid or out of range (x and y 0 to 100,
  zoom 1 to 3), 409 if `contentHash` is not the current cover (checked in the `UPDATE` itself). Stored in
  `albums.cover_framing` (migration `0022_album_framing.sql`, additive, nullable JSON `{ hash, x, y, zoom }`; the centre
  at 1x is NULL), an owner-edited column the triggers do not touch; it is lost if the album empties and its row is
  removed. The paged `GET /albums` returns `coverFraming: { x, y, zoom } | null` to owners and viewers, only while
  `hash` equals the current cover (`db/framing.ts`), so a new cover shows centred and going back restores the old framing
  unless another cover was framed in between. Cost (not measured on real D1): `GET /albums` reads one more column, no
  extra rows, plus a small JSON parse per album row with framing (at most 48); saving is one `albums` primary-key read
  and one row written. The Worker stores and serves no hero image.
- `routes/album-contents.ts` - `GET /albums/contents?name=` returns `{ people, known, species }` for one album the viewer can
  see (404 otherwise, 400 without `name`): per-list tiles with `photoCount` (distinct photos), at most 200 each, sorted by
  count then name; people use only `auto` and `confirmed` faces and carry the viewer's own label or `null` for people they
  do not own (`PERSON_NAME_SQL`, evaluated once per tile and once per kept cover, not per face row); covers are one face per person or known id (window function), the species cover is the
  best-scored photo. One `DB.batch` of 6 statements, 0 written; rows read are the album's photos plus about 4 passes over
  its faces, `json_each` over `photos.species` runs in D1 (UNMEASURED on real D1; fallback: a `photo_species` table, see the
  spec). `GET /search` also takes `species=<scientific name>` (`db/species.ts`), AND-combined with the other filters.
  The album page (`AlbumPhotos`) reads it once per view (React Query, 5 minutes) for its People and Species tabs; a tile
  sets one of `people`, `known`, `species` in the URL (one at a time) and the photo grid uses `/search`. A filtered page with no results says "No photos in this album match this filter."; a filter chip for a person the user created links to "View all photos of <name>" (`/people/<id>`).
- `routes/timeline.ts` - `GET /timeline` returns date groups, newest first, as
  `{ groups: [{ key, total, shown, photos }], nextCursor }`. Params: `zoom`
  (`year`, `month` default, `day`; groups are months, months, days, with an
  `undated` group last at day zoom only), `groups` (page size, integer 1-24,
  default 6), `cursor` (the last key of the previous page), plus `album`,
  `people` and the date filters below. `total` is the true count; `shown` is how
  many are returned. Day returns all photos. Month returns photos with a
  combined score >= `HIGHLIGHT_THRESHOLD` (6.0), topped up to the best
  `MIN_PER_GROUP` (3) rated photos. Year returns the best `YEAR_CAP` (6) per month.
  Unrated photos only appear at day zoom. Month and year zoom omit undated
  photos entirely (the buckets `undated` count still covers them for the
  scrubber). Once `to` is set, photos with no date fail the date filter, so at day
  zoom the Undated group is not reachable until "Back to latest" clears `to`.
  `GET /timeline/buckets` returns
  `{ buckets: [{ month, total }], undated }` for the scrubber (honours `album`
  and `people` only). Both are read-only and need no migration. A photo counts
  as dated only when `date_time` starts with a full `YYYY-MM-DD`; NULL, EXIF
  style `2025:06:02 ...` or other junk is undated in both routes. Pages read
  through `idx_photos_date_time`: with a cursor, the keys pass reads only rows
  older than it, and the photos pass reads only the page's own date range. The
  first keys page still reads every dated row, and at day zoom the undated count
  (and the photos pass of the page that holds the `undated` group) reads the
  whole table, but only once the dated days run out.
- `db/dateFilter.ts` - shared by `/search` and `/timeline`: `from` and `to`
  (inclusive `YYYY-MM-DD`, compared against `photos.date_time`) or `onThisDay`
  (`MM-DD`, Feb 29 allowed, matches that month and day in any year). Invalid
  values, `to` before `from`, or `onThisDay` combined with `from`/`to` return
  400 with `{ error }`; `/timeline` also returns 400 for a bad `zoom` or `groups`.
- Dates are UTC, not the local date taken (known limitation). The agent reads
  the EXIF capture time (which has no offset) as local time on the indexing
  machine and stores `toISOString()`, so `photos.date_time` is the UTC instant
  and its `YYYY-MM-DD` prefix is the UTC date. Day groups, month and year groups,
  the scrubber buckets, `from`/`to` and `onThisDay` all compare that UTC prefix.
  For an owner in IST (UTC+05:30), a photo taken between 00:00 and 05:29 local
  time lands on the previous day, so a 00:30 photo on 1 January is grouped under
  31 December of the year before; west of UTC, evening photos move to the next
  day instead. The Search "Today" chip builds its range from the browser's local
  date, so it can miss this morning's early photos. A follow-up should either
  store the local wall-clock time in the agent or add an owner UTC offset that
  the Worker applies before grouping and filtering.
- `routes/search.ts` + `search/synonyms.ts` - FTS5 search (optional `people=<id>,<id>` "together" filter, max 5, all must appear via auto/confirmed faces; optional `known=<Qid>,<Qid>` known-personality filter, AND, sharing the cap of 5 with `people`, also on `/timeline` and `/timeline/buckets`) with query-time
  synonym expansion; no re-index is needed to change it. Category words
  (`search/wildlife-synonyms.json`, e.g. "big cat" -> leopard, tiger) and
  word families (`search/word-families.json`: "hard" nouns/places, "soft"
  actions) are matched on word boundaries with plurals folded. Search tries
  tiers until one finds photos (the dictionaries were built from the library's own
  vocabulary: `SELECT lower(value), COUNT(*) FROM photos, json_each(photos.subjects)
  GROUP BY 1 ORDER BY 2 DESC`, same for `tags`; the model already writes
  category and scientific names, so entries map between those variants): all groups (AND), then without soft action
  groups, then any group (OR, bm25-ranked). All terms are quoted. Colour
  words have families too (red/crimson/scarlet), and filler such as
  "shade" or "background" is ignored, so "tiger on a green background" is
  tiger AND green (colours are a photo-level list, not per region).
- Field weighting: `photos_fts` indexes two columns, `search_text` (everything)
  and `search_primary` (subjects, tags, colours, caption, with owner overrides).
  `bm25(photos_fts, 1.0, 4.0)` ranks primary matches higher. `search_primary`
  is written by ingest, `PATCH photos/:id` and `ingest/rating` via
  `primaryTextForRow` / `buildPrimaryText`; migration `0008` backfills it in
  SQL (no model calls).
- `db/photos.ts` - D1 queries. Schema changes are numbered SQL files in
  `migrations/` and registered in `migrations/index.ts`.
- Derived tables (migration `0015_albums.sql`, additive): `albums` (one row per album: `photo_count`, cover photo and
  thumbnail hash, `latest_date`, `newest_indexed`, `avg_score`) and `counters` (`photos` total) are maintained by
  triggers on `photos` and `album_covers`, never by route code. `GET /albums` and the album names list read `albums`;
  the unfiltered `GET /search` total reads `counters`. The trigger SQL is in `migrations/albums.ts` and the `.sql`
  file is generated from it (`npm run gen:albums-migration`). `idx_photos_last_indexed` serves the unfiltered list.
- Tests run in the Workers runtime via `@cloudflare/vitest-pool-workers`.

### `agent/` - local indexing agent (Node/TS, tsx)

- `cli.ts` is the entry point. Commands: `index-local`, `index-drive`,
  `index-batch`, `index-status`, `backfill-exif`, `backfill-ratings`,
  `backfill-faces`, `serve-originals`. `move-album` is a separate script
  (`moveAlbumCli.ts`, `npm run move-album`): it moves an album folder on disk and
  calls `POST /ingest/relocate` (whole-segment path-prefix rewrite of local
  photos' `path`, with `dryRun`) so the index follows the files.
- Pipeline per photo (`processFile.ts`): hash content, skip if already indexed
  (`check-hashes`), read EXIF, make a thumbnail (sharp), ask Ollama for a
  description/tags/caption/quality rating, then push to the Worker.
- `batch/` - resumable multi-folder indexing with state in
  `agent/.index-state/` (gitignored). `scripts/install-launchd.sh` runs it at
  login.
- `google/` - OAuth (read-only scope) + recursive Drive folder listing (`driveFiles.ts`: breadth-first, shared drives
  included, retry with backoff, `sha256Checksum` read from the listing so already-indexed photos are skipped before any
  download) and `indexGoogleDriveFolder.ts` (album = first folder under the picked one, `albumFromDrivePath`; Processed, RAW and skip-list rules in `driveScan.ts`). Agent-only:
  no Worker CPU or D1 change; a re-run adds one `check-hashes` request per 500 photos and no downloads for known ones.
- `originals/` - local server exposing full-resolution files, reached via
  `cloudflared` (`agent/cloudflared/`).

## Data flow

1. `agent` indexes: files -> hash -> Ollama analysis -> `POST /ingest/*` on the Worker.
2. Worker stores rows in D1 (with FTS5 text) and thumbnails in R2.
2b. Album hero (once per browser and cover): browser -> `/api/originals/:id` -> IndexedDB. A stored hero makes no request;
while the original is unavailable, each album page visit tries again (one access check, and one Drive call for a Drive photo).
3. Browser -> Pages `/api/*` -> Pages Function adds token -> Worker read route.
3b. Request access (signed out): browser -> `/enroll` -> `POST /api/enroll` (Turnstile) -> Worker `POST /enroll` -> `access_requests`;
   the admin approves on `/admin/access` -> Worker -> Cloudflare Access API (group edit, session revoke).
4. "View original": browser -> `/api/originals/:id` -> tunnel -> agent server
   (local files, or Drive files streamed with the agent's Google token via
   `files.get alt=media`, nothing staged on disk). The photo page adds an
   "Open in Google Drive" link (album owner only: `driveFileId` is `canEdit`-gated).
   Agent-only change: no Worker CPU or D1 change.

## Species identification

Why: the vision model is unreliable at naming birds, so an optional local sidecar (`SPECIES_SIDECAR_URL`,
`agent/sidecar/species_server.py`) runs BioCLIP 2.5 Huge (fp16, about 3 GB resident) on the whole frame and on each OWLv2-detected bird.
`POST /species?region=` returns raw candidates; `agent/src/species/decide.ts` chooses what to store
(whole-frame answer for mammals and other animals, bird boxes for birds, a species once with its best
score, both animals of a two-animal photo, score below 0.5 dropped; a whole-frame answer below 0.9 also needs an animal word in the vision model's stored subjects (`species/cue.ts`), since the whole-frame answer always names the closest animal and non-animal photos got mid-confidence wrong species; thresholds from a labelled evaluation).
The region (`species/regions.ts`, `agent/species/regions.json`) comes from the EXIF position (boxes), else the
album name, else the default, and selects a GBIF species list (`build-species-regions`, local files under
`agent/.index-state/species-regions/`). `identifySpecies` (`species/identify.ts`) is shared by indexing and the backfill.

Storage: `photos.species` (JSON `[{common, scientific, score, box?}]`, default `[]`) and `photos.species_model`
(NULL until scanned; set even when nothing was found), migration `0020_species.sql`. `subjects` is untouched
(the ingest upsert overwrites it on every re-index). Search: the names go into `search_primary` (bm25 weight
4 in `/search`) and `search_text` (`speciesWords` in `worker/src/db/photos.ts`), except when the owner has set
`user_subjects` (their words win; the species stay stored and shown). `POST /ingest/photo` accepts `species`
and `speciesModel` (absent keeps the stored ones). Routes (ingest token only, outside the Pages proxy allowlist):
`POST /ingest/species` (up to 100 photos by content hash, one SELECT by the unique hash index plus one batched
UPDATE each, search text rebuilt from the row so repeats never pile up), `POST /ingest/species/pending` (rowid
cursor, up to 100, local and `google_drive` photos not scanned with this model, optional `album`) and
`POST /ingest/species/summary` (per album total and pending, one pass over `photos`, for `backfill-species --list`).

`backfill-species` is driven by D1 like `backfill-faces`, so it needs no folders: it pages the pending photos,
opens each original from its local path or from Google Drive (`species/driveReader.ts`: stored login only,
never a sign-in, `DRIVE_STAGING_MAX_MB` cap, in memory, no staging file), and writes batches of 25. Missing
files and Drive photos without a login stay pending; five failures in a row stop the run (sidecar down).
Agent-only except the routes above: no new Worker loop over embeddings, CPU is a short JSON parse and string
build per photo.

## Faces and people

Flow: after the Ollama analysis, the agent posts the image to the local sidecar
(`FACE_SIDECAR_URL`, `POST /faces`) and sends the faces (normalised bbox,
`det_score`, 512-d L2-normalised embedding, model name) to `/ingest/faces`.
A sidecar failure is logged and never fails the photo. Known matching: `scanFaces` matches each kept face's embedding against the local gallery (`agent/.index-state/known-gallery.json`, loaded once per command by `src/known/loadKnownGallery.ts` and passed down as `gallery` / `knownGallery`; missing or corrupt means no matching, the corrupt case warns once) and posts `known: {id, score}` only for a confident match. A gallery built with a different face model than the detection warns once per run and posts no `known`; a face with an undecodable embedding is skipped. Cost is about 3.3 ms per face on the agent machine (405 people x 10 refs), local only. `backfill-faces` does the
same for already indexed photos and is resumable via `photos.faces_scanned_model`. It is driven by the
index: `POST /ingest/faces/unscanned` pages (by rowid) through local photos not yet scanned with the
sidecar's model and returns each one's content hash and source path (optionally limited by a path prefix),
so the agent never walks or hashes folders; files missing from disk are counted and retried later.
The owner then names faces in the UI; the Worker matches the rest.

Tables (migration `0009_people.sql`, additive): `persons`, `faces` (embedding BLOB,
`person_id`, `assign_status` of `unassigned|auto|confirmed`, `match_score`) and
`face_rejections` ("Not X" corrections, so a rejected pair is never re-matched),
plus `photos.faces_scanned_model`. Re-ingesting a photo replaces only its
`unassigned` and `auto` faces and carries over rejections by bbox overlap;
`confirmed` faces are kept. Ingest bodies cannot set `person_id` or `assign_status`.

Matching (`worker/src/people/`): each named person is represented by up to
`REFERENCES_PER_PERSON` (30) reference embeddings (confirmed faces spread across years, below; people with none are skipped); a
face's score is its best dot product against a person's references. Only faces
with `det_score >= MIN_DET_SCORE` (0.7) and both sides `>= MIN_FACE_SIDE` (0.05,
fraction of the image) are matchable. A score `>= AUTO_THRESHOLD` (0.5) attaches
the face as `auto`; `>= SUGGEST_THRESHOLD` (0.4) only surfaces it as a suggestion
to review. Matching runs automatically at ingest (`autoMatch.ts`) and when a
group or face is named, and can be re-run from the person's page
(`POST people/:id/match`). In the UI those calls run in a background queue
(`src/services/matchQueue.ts`, one per query client; progress card
`components/MatchStatus.tsx` in the layout): the save returns at once, people are
matched one at a time (a person already waiting is not queued twice), page
changes do not stop it, and closing the tab does (the browser asks first).

A match request without `from` checks every candidate (unnamed faces and other
people's auto faces): that is Re-run matching and Review suggestions. The
automatic run after naming sends `from` (at most 50 ids): the people the named
faces were just removed from ("Not X" or "Remove name", remembered in the browser
until the face is named; a page reload forgets it), usually none. The Worker then
works in two phases so each set is walked once: the unnamed faces
(`MATCH_UNNAMED_SQL`, cursor `<rowid>`), then, if `from` is not empty, those
people's auto faces (`MATCH_MOVED_SQL`, cursor `m<rowid>`, first one `m0`).

Unnamed faces are grouped by centroid clustering
(`clusterFaces`) for the People page.

`POST /ingest/faces` answers with `faceIds` (the id each posted face was stored under; a kept confirmed face keeps
its own). The agent then sends each face's crop (a padded 192 px square cut from the original) as raw JPEG bytes
to `PUT /ingest/faces/:faceId/crop`, one small request per face, because decoding base64 crops inside the ingest
request exceeded the free tier's CPU limit (HTTP 503). The Worker stores it in R2 at `faces/<faceId>.jpg` (`faces.crop_key`, migration `0012_face_crop.sql`, additive),
serves it at `GET /faces/:id/crop` (read token; the Pages proxy caches it for a day) and exposes it as
`cropUrl`. A re-scan deletes the crops of the faces it replaces; a kept confirmed face can take a new crop without touching its name. `backfill-faces --recrop` (`missingCrops` on `/ingest/faces/unscanned`) re-scans
photos that have a crop-less face.

A person's cover (`persons.cover_face_id`, migration `0011_person_cover.sql`, additive) is the
owner's pick via `POST people/:id/cover` while that face is still confirmed or auto-matched to the
person. Otherwise `GET /people` picks their biggest confirmed face (box area, then detection score).
There is no foreign key: validity is checked when read, so unassigning the face or deleting it just
falls back to the default.

References are stored in `person_references (person_id, face_id)` (migration
`0023_person_references.sql`, which also fills it). The rule
(`referenceSelection.ts`): bucket a person's confirmed faces by the photo's year
(no date is its own bucket), rank each bucket by face box area, then detection
score, and take turns across buckets until 30. `refreshReferences` runs after
every write that changes confirmed faces (naming, "Not X", "Remove name", a
confirming review) and on the first page of Re-run matching: one statement reads
the choice, then one batch writes only the difference. It is not in the write's
transaction and never fails the request. `loadReferences` reads the table and
still requires each face to be confirmed for that person, so a stale row is
ignored. A photo date changing at re-index is picked up by the next refresh, and
so is a confirmation made by the previous Worker during a deploy. Deleting a
person deletes their rows. Ingest-time matching uses `loadReferencesCached`
(per-isolate, 60 s TTL), so a person confirmed in the last minute may be missed
by that pass; the owner-driven match route is never cached.

Limits, chosen for the Workers Free plan (CPU time and about 50 D1 queries per
invocation):

- Work is paged: `FACE_PAGE_SIZE` 100 faces for matching, `GROUPS_PAGE_SIZE` 50
  for groups. The match page query (`MATCH_CANDIDATES_SQL`) walks `faces` by rowid
  from the cursor and stops at the page size; it deliberately avoids the
  `assign_status` index, which made every page read and sort all remaining
  candidates (on the real database, with about 14,000 candidates, the first page
  went from 80,952 rows read to 540). `apply` and ingest-time matching write with one set-based
  `UPDATE ... json_each` statement; bulk assign/create use two.
- Ingest-time matching spends at most `MAX_AUTO_MATCH_MACS` (1,500,000
  multiply-adds, faces x reference vectors x 512) per request. Faces beyond the
  budget stay `unassigned` and are counted in the `skipped` field of the
  `/ingest/faces` response (at least one face is always scored). Re-run matching
  from the person's page to catch them.
- `/ingest/faces` accepts at most 10 faces per request (400 above); the agent
  keeps the 10 largest by box area, which keeps a crowd photo under D1 Free per-invocation query limit.
- Embeddings are read as a `Float32Array` view (little-endian, as on Workers/D1)
  and must be exactly 512 floats.
- CPU evidence: a reviewer micro-benchmark on Apple silicon (decode and scoring
  only, excluding D1 and JSON) measured about 5-9 ms for match 300x30, 6-10 ms
  for groups 150 and 8-12 ms for ingest of 10 faces x 50 people x 30 refs, before
  these limits were tightened. Real Worker CPU has not been measured: before
  relying on these constants, measure on a deployed preview (`wrangler tail` or
  the dashboard) and tune them. This is a to-do for the owner at merge.

### Reviewing auto matches

`GET /people/review-queue` counts the caller's people's `auto` faces in albums they own, most first; the "To review"
page (`/review`) and the People page link use it, joined in the browser with `GET /people` for names and covers.

`GET /people/:id/faces?photos=` returns the faces of one person on 1 to 48 photos. The person page sends one request
for each page. The route reads only photos that the caller can see, and it writes nothing. An unknown person or photo
gives no faces.

`GET /people/:id/auto-faces` pages a person's `auto` faces in albums the caller owns, weakest match first (keyset on
score and rowid, 48 per page). `POST /people/:id/auto-faces/review` (`{ confirm, reject }`, 1 to 200 ids in total)
changes only faces that are, at write time, still that person's auto match in an owned album, and returns the ids it
changed; anything else is skipped. Unlike `confirmFacesStmts` (naming a face), it never clears an ignore or a
rejection. Both are for the person's owner. No migration and no new index (see `docs/development.md` for cost).

### Ignored faces

`faces.ignored_at` (migration `0021_face_ignore.sql`) marks a face the album owner does not care about. Such a face is
always `unassigned`; it is left out of unnamed groups, matching (at ingest and on demand) and every known-personality
view, and a re-scan keeps it like a confirmed face. Writes are `POST /faces/ignore` and `/faces/restore` (owner only, up
to 200 ids, set-based); `GET /people/ignored` pages them for the undo list. Naming an ignored face clears the flag.

Indexes: three partial indexes on `ignored_at` were added and none changed, so queries written before this feature keep
their plans (see `docs/development.md`).

### Known personalities (phase 1)

Data: migration `0018_known_people.sql` adds `known_people` (Wikidata id, name, aliases JSON), `faces.known_id`, `faces.known_score`
and the partial index `idx_faces_known_photo (known_id, photo_id) WHERE known_id IS NOT NULL`. All additive.

Flow: the agent builds a local gallery of reference embeddings from openly licensed Commons photos
(`build-known-gallery`, `agent/.index-state/known-gallery.json`, uncommitted) and syncs the people list to the Worker
(`POST /ingest/known-people`). Matching is cosine similarity on the agent only (threshold 0.6, margin 0.05 over the runner-up, both
initial guesses); the Worker never loops over embeddings. The gallery is matched only on the agent; its backup is one R2 object `known/gallery.json` written and read only by the agent through `PUT`/`GET /ingest/known-gallery` (ingest token, not in the Pages proxy allowlist). The Worker streams the bytes to and from R2 (64 MB cap, no parsing, no D1, no matching). `build-known-gallery` restores it when the local file is missing and pushes after a changed build or when `GET /ingest/known-gallery/status` (one R2 head) reports no backup. Performance: one R2 put per build that changed the gallery (about 11 MB for 405 people x 10 refs), one R2 get on a restore, one R2 head per unchanged build, zero D1 queries, and the Worker does no JSON work (the body is streamed through, never parsed); these are Class A (put) and Class B (get) R2 operations, a handful per month. New faces carry `known: {id, score}` (nullable) on `POST /ingest/faces`.
Existing faces are matched by `backfill-known`, which pages stored embeddings (`POST /ingest/faces/embeddings`, raw bytes, keyset by
rowid, `limit` at most 100 within a 5000-rowid window) and writes matches back in batches of up to 200 (`POST /ingest/faces/known`,
`knownId: null` clears). A match is a "looks like" suggestion: it never sets `person_id` or `assign_status`.

Read side: `GET /people/known` lists known people with a matched face in a photo the viewer can see; `known=<Qid>,...` on `/search`,
`/timeline` and `/timeline/buckets` is an AND filter sharing the cap of 5 with `people` (people first, extras silently dropped). The
People filter on Search and Timeline shows "Your people" (blue) and "Known personalities in your photos" (violet, with a "known"
marker). Cost and measurement notes: `docs/agents/` (performance reviews) and `docs/development.md`.

Known limits: matching ignores `faces.embedding_model`. After a face model
change, faces must be re-scanned and re-confirmed (phase A does not mix models).
"Remove name" in the UI is soft: it only unassigns a confirmed face (an `auto`
face is corrected with "Not X", which records a rejection) and can be re-matched
later.

Bounding boxes are stored in the raw (EXIF-unrotated) frame of the thumbnail,
which is what the UI draws over. The agent detects on an upright image and maps
each box back through the photo's EXIF orientation before posting.

Licence: InsightFace pretrained weights are non-commercial, personal use only.

## Config and secrets

| Where | Variables |
| --- | --- |
| Root `.env` / Pages secrets | `WORKER_URL`, `READ_TOKEN`, optional `ORIGINALS_BASE_URL`, `ORIGINALS_TOKEN`, `ACCESS_CLIENT_ID/SECRET`; identity: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` (both required); `TURNSTILE_SECRET`, `TURNSTILE_SITE_KEY` (enroll page; both required or enroll is off); local dev only: `DEV_VIEWER_EMAIL` |
| `agent/.env` | `CLOUDFLARE_API_BASE_URL`, `INGEST_TOKEN`, `OLLAMA_*`, `GOOGLE_OAUTH_*`, `ORIGINALS_PORT/TOKEN`, `READ_TOKEN`, `OWNER_EMAIL` (the album owner: required to index, sent as `ownerEmail`; also the viewer for `serve-originals` and `index-status`), optional `FACE_SIDECAR_URL` (face scanning is off when unset), optional `SPECIES_SIDECAR_URL` (species identification is off when unset) |
| Worker secrets | `READ_TOKEN`, `INGEST_TOKEN`, `ADMIN_EMAIL`, `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_ACCESS_GROUP_ID` (the Worker never reads `OWNER_EMAIL`; an old Worker secret of that name can be deleted; `CF_API_TOKEN` is as sensitive as the admin login) |
| `worker/wrangler.toml` | `[[ratelimits]]` binding `ENROLL_LIMITER` (5 per 60 s); `namespace_id`: 7410061 is a valid id; change it only if the account already has a rate limiter with that id |

Never prefix server-side secrets with `VITE_`.
