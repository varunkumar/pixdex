# Known personalities

Agent notes. Read this file before you change this area. Update it with each change.
The core rules are in [`AGENTS.md`](../../AGENTS.md). Paths are relative to the repository root.

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
