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

- `components/` - Search (People filter kept in the URL as `people=<id>,<id>`), Albums, AlbumPhotos, PhotoDetail, PhotoReview (stars
  and AI overrides), PhotoFaces/FaceTile (name and correct faces on the photo
  page), People (`/people`: named people plus unnamed face groups to name) and
  PersonPage (`/people/:id`: photos sorted newest/best rated/alphabetical via `sort`, rename/delete, suggestion review, re-run
  matching), Dashboard,
  DailySuggestion, Lightbox, PhotoGrid/PhotoCard, Layout.
- `services/api/WorkerApiClient.ts` - the only place that talks to the backend.
  It calls same-origin `/api/*`.
- `hooks/useListParams.ts` - sort/page state kept in the URL so listings are
  linkable and "back" returns to the same sort and page.
- `types/api.ts` - API response types shared by components.
- Tests sit next to code in `__tests__/`; helpers in `src/test/`.

### `functions/api/[[path]].ts` - Pages Function proxy

Same-origin read proxy. Adds `READ_TOKEN` server-side so it never ships in the
bundle. Only an allowlist of read routes is forwarded (`search`, `albums`,
`daily-pick`, `photos/:id`, `photos/:id/faces`, `thumbnails/:hash`, `faces/:id/crop`, `people`,
`people/groups`) plus `originals/:id`, which goes
to the agent through the tunnel. `/ingest/*` is deliberately not reachable.
Thumbnails are cached immutably (content-hash addressed); other routes use
`no-cache`. The only writes the browser can make are `PUT albums/cover`,
`PATCH photos/:id`, `PATCH`/`DELETE people/:id`, and `POST` to `people`,
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
by people x `REFERENCES_PER_PERSON`.

Limits, chosen for the Workers Free plan (CPU time and about 50 D1 queries per
invocation):

- Work is paged: `FACE_PAGE_SIZE` 200 faces for matching, `GROUPS_PAGE_SIZE` 100
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
| Root `.env` / Pages secrets | `WORKER_URL`, `READ_TOKEN`, optional `ORIGINALS_BASE_URL`, `ORIGINALS_TOKEN`, `ACCESS_CLIENT_ID/SECRET` |
| `agent/.env` | `CLOUDFLARE_API_BASE_URL`, `INGEST_TOKEN`, `OLLAMA_*`, `GOOGLE_OAUTH_*`, `ORIGINALS_PORT/TOKEN`, `READ_TOKEN`, optional `FACE_SIDECAR_URL` (face scanning is off when unset) |
| Worker secrets | `READ_TOKEN`, `INGEST_TOKEN` |

Never prefix server-side secrets with `VITE_`.
