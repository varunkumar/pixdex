# PixdeX

Browse and search UI for a personal photo collection. A React frontend talks to
a Cloudflare Worker (D1 + R2); a separate local agent indexes photos with a
local Ollama model and pushes metadata and thumbnails to the Worker. Originals
never leave local disk or Google Drive.

## Layout

- `src/` - React 19 + Vite + Mantine frontend (calls same-origin `/api/*`);
  the Search page is one omnibox (`src/components/Search.tsx`; bar `src/components/omnibox/Omnibox.tsx`, panel `SuggestionPanel.tsx`,
  data `src/hooks/useOmniboxData.ts`, matcher `src/services/omnibox/matcher.ts`, URL state `src/services/omnibox/urlState.ts`, colours
  `src/components/chipStyle.ts`, dark-mode ink vars `--pixdex-ink-*` in `src/index.css`) with a plain mode and an AI mode (Chrome Prompt API only,
  client side; "Ask AI" / Cmd+Enter and the plain-mode "Add keywords" button, which sets `mode=ai` so keywords can be typed without the
  model, exist only where supported): AI result cards in `src/components/AiResults.tsx`, logic in
  `src/services/aiSearch/`, support gate in `src/hooks/usePromptApiSupport.ts`. `/ai-search` is only a redirect
  (`src/components/LegacyAiRedirect.tsx`) to `/search?mode=ai` (old `people=0` becomes `hidePeople=0`; without support the AI params are
  stripped); there is no AI Search nav entry. AI params: `mode=ai`, `q`, `kw`, `hidePeople=0`, `room=0`. `dev/mockApi.ts` is the dev-only dummy API
- Frontend gating (hidden, never disabled): photo review controls and the photo's face-naming controls use
  `photo.canEdit` (the user owns the album); album cover and Share use the album's `role === 'owner'` (the album page reads it from
  its `album-summary` query); rename, delete, matching and covers on a person use that person's `canEdit` (the user created it).
  `useMe()` (`src/hooks/useMe.ts`, `GET /me`, `staleTime: Infinity`) returns only `{ email, loading }`. The share dialog is
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
  `GET /me` (`{ email }`, no D1), `PUT /albums/shares` (owner only, max 50 emails), `GET /access/photo/:id` (204 or 404,
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
- Write authorization (worker): every non-ingest write authorizes itself in its handler (`albumRole`, `faceRoles`, `personRole`)
  and is registered with `guardedWrite` in `worker/src/index.ts` (`guardedWrites`); `worker/test/sharing-writes.test.ts` fails
  otherwise. `POST /ingest/photo` requires `ownerEmail` (trimmed, lowercased email): it returns 409 for an album owned by another
  user and stamps the owner on an unowned album once (one extra single-row write). `shared_with` is only ever written as valid
  JSON or NULL.
- `functions/api/` - Cloudflare Pages Function: token-adding read proxy (reads
  include `GET timeline`, `GET timeline/buckets`, `GET people/known` and `GET me`; also
  forwards the browser writes: `PUT albums/cover`, `PUT albums/shares`, `PATCH photos/:id`,
  `PATCH`/`DELETE people/:id`, `PUT`/`DELETE people/:id/label`, and `POST` to `people`, `people/:id/faces`,
  `people/:id/match`, `people/:id/cover`, `faces/:id/assign|reject|unassign`). It first verifies the Cloudflare Access
  JWT (`functions/_lib/access.ts`) and forwards the verified email as `X-Viewer-Email`; for `GET originals/:id` it first calls the
  Worker `GET /access/photo/:id` (READ_TOKEN, not in the browser allowlist) for every user
- `functions/_lib/` - shared Function code: Access JWT verification (`access.ts`, JWKS cached in module memory)
- `worker/` - Hono Worker: ingest + read API, D1 migrations, FTS5 search
- `agent/` - local Node/TS indexing CLI, originals server, and the `move-album` script
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
  (scales with the global count of matched faces); the `known=` filter is one more subquery on `idx_faces_known_photo`. UNMEASURED: the
  embeddings route CPU and the D1 BLOB decode (D1 may return a number[]; `limit` at most 100 is the knob), and the backfill time, estimated
  at 1 to 3 minutes for about 5K photos: measure both with `wrangler tail` after deploy.
- Known personalities UI status: the omnibox and the Timeline `PeopleFilter` were checked in a real browser, light and dark, against the dev mock (`PIXDEX_MOCK=1 npm run dev`); the real library has no known matches yet, so real-data behaviour is unchecked.
- `agent/sidecar/` - local Python InsightFace service (face detection and embeddings), see its README
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
- `faces.person_id` and `faces.assign_status` are owner/Worker decisions: the agent
  and ingest request bodies never set them (unknown keys are dropped). The Worker's
  own matching only ever writes `auto`; `confirmed` comes from the owner via the
  browser writes. Rejections live in `face_rejections`.
- In `worker/`, import zod as `import * as z from 'zod/mini'` (functional API, `z.flattenError(err)`), never from
  `'zod'`: the classic build adds about 450 KiB to the Worker bundle. `agent/` may use classic `zod`.
- DB changes go in a new numbered file in `worker/migrations/`.
- `albums` and `counters` are derived by triggers (`worker/migrations/albums.ts` generates
  `0015_albums.sql` via `cd worker && npm run gen:albums-migration`). Never write them from route code; change
  the generator and add a new numbered migration. Exception: the owner-edited `albums.owner_email` and
  `albums.shared_with` (migration `0016`) are not derived; only `PUT /albums/shares`, the first-photo stamp in
  `POST /ingest/photo` and the one-time `worker/scripts/backfill-owner.mjs` write them.
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
  grouped aggregate over `idx_faces_known_photo` (faces pinned as outer table with CROSS JOIN) plus one `json_each` name lookup. Its
  read cost scales with the global count of known-matched faces (index walk, scope filtered after), not with the viewer's photos.
- `known=<Q1,Q2>` on `/search`, `/timeline` and `/timeline/buckets` (`worker/src/db/known.ts`: `parseKnown`, `knownFilterSql`) is an AND
  filter: the photo needs a face matched to every id (with or without a person). It shares the cap of 5 with `people` (people take slots
  first, extra known ids are silently dropped, never a 400), ids are bound, and the subquery walks `idx_faces_known_photo`; an unknown id is just zero results.
- Search omnibox (`src/components/omnibox/`): the bar shows album, own-people (blue), known (violet, "known" marker) and date chips; typed words
  become suggestions through the shared matcher (`src/services/omnibox/matcher.ts`: debounce 150 ms, from 3 characters per span, each word
  matches anywhere inside a name or alias word, case and accent insensitive, no fuzzy matching, longest span wins, a person never used twice,
  at most 3 ambiguous chips per span plus "+N more"); typing alone never filters; Enter is a plain search, "Ask AI" / Cmd+Enter only where the
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
