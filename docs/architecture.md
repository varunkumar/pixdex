# Architecture

PixdeX is a browse and search UI for a personal photo collection. Original
photos never leave local disk or Google Drive; only derived data (metadata,
captions, ratings, thumbnails) lives in the cloud.

```
Your Mac
  ├─ Ollama (vision + text generation, local)
  ├─ agent/sidecar/  (Python InsightFace service: face detection + embeddings, optional)
  ├─ agent/  (Node/TS CLI: index photos, serve originals)
  └─ cloudflared tunnel (originals on demand only)

Cloudflare
  ├─ worker/    Hono Worker: ingest + read API
  ├─ D1         photo metadata + FTS5 search index
  ├─ R2         thumbnails only
  └─ Pages      src/ (React UI) + functions/api (same-origin proxy)
```

Browsing and searching never needs the Mac: it is served from D1/R2. The Mac is
needed only to run an indexing pass or to fetch a full-resolution local original.
Drive-sourced photos deep-link to Drive and need no tunnel.

Original design rationale: `docs/superpowers/specs/2026-09-18-pixdex-local-cloud-redesign-design.md`.

## Components

### `src/` - frontend (React 19, Vite, Mantine, TanStack Query, react-router)

- `components/` - Timeline (day/month/year zoom via Ctrl+wheel or pinch, state in the URL; a zoom change away from the newest month writes `to` = end of the active month in the same replace navigation, so the period being read is kept, year/month scrubber rail with a floating month label while dragging, year labels thinned to at least 12px apart, a "Back to latest" chip after a jump, and Retry buttons for a failed first or next page), Search (People filter kept in the URL as `people=<id>,<id>`; date range picker, quick chips and an "On this day" chip in the URL as `from`, `to`, `onThisDay`; typed dates such as `june 2025` parsed by `services/dateQuery.ts`), Albums, AlbumPhotos, PhotoDetail, PhotoReview (stars
  and AI overrides), PhotoFaces/FaceTile (name and correct faces on the photo
  page), People (`/people`: named people plus unnamed face groups to name) and
  PersonPage (`/people/:id`: photos sorted newest/best rated/alphabetical via `sort`, rename/delete, suggestion review, re-run
  matching), Dashboard,
  DailySuggestion, Lightbox, PhotoGrid/PhotoCard, Layout.
- AI Search (`components/AiSearch.tsx`, `services/aiSearch/`, `hooks/usePromptApiSupport.ts`): runs
  entirely in the browser and only exists where Chrome's Prompt API (Gemini Nano) is available (the
  nav entry and route are gated on it). It uses only existing read routes through the existing proxy (`GET search` and thumbnail reads):
  no new allowlist entries and no Worker, D1 or agent change. URL state: `q`, `kw`, `people=0`,
  `room=0`. Pipeline: (1) the Prompt API expands the phrase into keywords (`promptApi.ts`);
  (2) one `GET search` per keyword (sorted by rating, 100 per keyword) plus a library total;
  (3) photos are scored by rarity-weighted keyword match, each hit adding `log(libraryTotal / keywordTotal)`,
  (`ranking.ts`); (4) optionally drop people photos, using stored
  `subjects` and `tags` matched against a word list (not face data); (5) the top 150 candidates are
  kept, the keyword score is normalised to the best of those (`renormalize`), and, if "leave room for text" is on, each thumbnail is measured in a canvas for calm empty space
  (`textSpace.ts`); (6) final score = 1.0 x keyword + 0.6 x empty space (when enabled) + 0.15 x rating/10,
  and the top 48 are shown (`pipeline.ts`).
- `services/api/WorkerApiClient.ts` - the only place that talks to the backend.
  It calls same-origin `/api/*`.
- `hooks/useListParams.ts` - sort/page state kept in the URL so listings are
  linkable and "back" returns to the same sort and page.
- `types/api.ts` - API response types shared by components.
- Date pickers use `@mantine/dates` and its `dayjs` peer dependency.
- Tests sit next to code in `__tests__/`; helpers in `src/test/`.

### Identity and album access

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
(owner only) replaces `shared_with`; `GET /me` returns `{ email }`. The Worker never reads `OWNER_EMAIL`: the agent sends
it as `ownerEmail` with each ingested photo (`POST /ingest/photo`), and the first photo of an album stamps the album's owner.

People are per owner (`persons.owner_email`, unique name per owner). A person is editable only by its owner; face assign,
reject and unassign need the face's album to be the caller's and any named person to be theirs. `GET /people` returns the
caller's people and other owners' people with a visible assigned face (`canEdit` per person); groups and match candidates
only cover faces in albums the caller owns, and matching never crosses owners (references cached per owner).

Originals: for every user, including the album owner, the Function first calls Worker `GET /access/photo/:id`
(READ_TOKEN plus their email); only a 204 is proxied to the agent tunnel, anything else is 404.
Thumbnails: one `content_hash` lookup joined to the album by primary key per request (the browser caches them for a year).
Single-photo reads use that join (`photoAccess`), list reads use the album subquery (`scopeFor`).
Viewers get `path` and `driveFileId` as null in photo responses (the owner's local path and Drive id are owner-only).

### `functions/api/[[path]].ts` - Pages Function proxy

Same-origin read proxy. Verifies the Access identity first (above). Adds `READ_TOKEN` server-side so it never ships in the
bundle. Only an allowlist of read routes is forwarded (`search`, `timeline`, `timeline/buckets`, `albums`,
`daily-pick`, `photos/:id`, `photos/:id/faces`, `thumbnails/:hash`, `faces/:id/crop`, `people`,
`people/groups`, `me`) plus `originals/:id`, which goes
to the agent through the tunnel. `/ingest/*` is deliberately not reachable.
Thumbnails are cached immutably (content-hash addressed); other routes use
`no-cache`. The only writes the browser can make are `PUT albums/cover`,
`PUT albums/shares`, `PATCH photos/:id`, `PATCH`/`DELETE people/:id`, and `POST` to `people`,
`people/:id/faces`, `people/:id/match`, `people/:id/cover` and `faces/:id/assign|reject|unassign`
(bodies JSON only, DELETE has none), all forwarded with the read token through
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
- `routes/search.ts` + `search/synonyms.ts` - FTS5 search (optional `people=<id>,<id>` "together" filter, max 5, all must appear via auto/confirmed faces) with query-time
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
- `google/` - OAuth + folder-scoped Drive listing (read-only scope).
- `originals/` - local server exposing full-resolution files, reached via
  `cloudflared` (`agent/cloudflared/`).

## Data flow

1. `agent` indexes: files -> hash -> Ollama analysis -> `POST /ingest/*` on the Worker.
2. Worker stores rows in D1 (with FTS5 text) and thumbnails in R2.
3. Browser -> Pages `/api/*` -> Pages Function adds token -> Worker read route.
4. "View Original": browser -> `/api/originals/:id` -> tunnel -> agent server
   (local files) or a Drive deep-link (Drive files).

## Faces and people

Flow: after the Ollama analysis, the agent posts the image to the local sidecar
(`FACE_SIDECAR_URL`, `POST /faces`) and sends the faces (normalised bbox,
`det_score`, 512-d L2-normalised embedding, model name) to `/ingest/faces`.
A sidecar failure is logged and never fails the photo. `backfill-faces` does the
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
`REFERENCES_PER_PERSON` (30) reference embeddings (the newest confirmed faces; people with none are skipped); a
face's score is its best dot product against a person's references. Only faces
with `det_score >= MIN_DET_SCORE` (0.7) and both sides `>= MIN_FACE_SIDE` (0.05,
fraction of the image) are matchable. A score `>= AUTO_THRESHOLD` (0.5) attaches
the face as `auto`; `>= SUGGEST_THRESHOLD` (0.4) only surfaces it as a suggestion
to review. Matching runs automatically at ingest (`autoMatch.ts`) and when a
group or face is named, and can be re-run from the person's page
(`POST people/:id/match`). Unnamed faces are grouped by centroid clustering
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

"Newest" references means newest by scan time (`faces.created_at`), not by when
the owner confirmed. `loadReferences` reads them through
`idx_faces_person_status_created` (migration `0010`), so rows read are bounded
by people x `REFERENCES_PER_PERSON`. Ingest-time matching uses
`loadReferencesCached` (per-isolate, 60 s TTL), so a person confirmed in the last
minute may be missed by that pass; the owner-driven match route is never cached.

Limits, chosen for the Workers Free plan (CPU time and about 50 D1 queries per
invocation):

- Work is paged: `FACE_PAGE_SIZE` 100 faces for matching, `GROUPS_PAGE_SIZE` 50
  for groups. `apply` and ingest-time matching write with one set-based
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
| Root `.env` / Pages secrets | `WORKER_URL`, `READ_TOKEN`, optional `ORIGINALS_BASE_URL`, `ORIGINALS_TOKEN`, `ACCESS_CLIENT_ID/SECRET`; identity: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` (both required); local dev only: `DEV_VIEWER_EMAIL` |
| `agent/.env` | `CLOUDFLARE_API_BASE_URL`, `INGEST_TOKEN`, `OLLAMA_*`, `GOOGLE_OAUTH_*`, `ORIGINALS_PORT/TOKEN`, `READ_TOKEN`, `OWNER_EMAIL` (the album owner: required to index, sent as `ownerEmail`; also the viewer for `serve-originals` and `index-status`), optional `FACE_SIDECAR_URL` (face scanning is off when unset) |
| Worker secrets | `READ_TOKEN`, `INGEST_TOKEN` (the Worker never reads `OWNER_EMAIL`; an old Worker secret of that name can be deleted) |

Never prefix server-side secrets with `VITE_`.
