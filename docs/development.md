# Development guide

Three independent npm packages, each with its own `package-lock.json`:
root (frontend), `worker/`, `agent/`. Run `npm install` in each you touch.

## Commands

| Package | Dev | Test | Typecheck / lint | Build / deploy |
| --- | --- | --- | --- | --- |
| root (frontend) | `npm run dev` | `npm test` | `npm run lint` | `npm run build` (`tsc -b && vite build`) |
| `worker/` | `npm run dev` (wrangler) | `npm test` | `npm run typecheck` | `npm run deploy` |
| `agent/` | `npm run dev -- <command>` | `npm test` | `npm run typecheck` | n/a |

Single test: `npx vitest run path/to/file.test.ts` inside the package.

## Pre-commit gate

`.githooks/pre-commit` (enabled by root `npm install` via `core.hooksPath`) runs
only the suites touched by staged changes:

- `worker/` changes: worker tests
- `agent/` changes: agent typecheck + tests
- anything else: frontend lint, tests, build
- docs/markdown/todo-only commits skip the gate

Do not bypass with `--no-verify`.

## Deploys

No GitHub Actions. Both the frontend and the Worker deploy from `main` via
Cloudflare's GitHub integration (connected to this repo), so merging or
pushing to `main` ships them.

| Part | Source | Trigger |
| --- | --- | --- |
| Frontend + `functions/api/` | root | Pages build from `main` (build `npm run build`, output `dist`) |
| Worker | `worker/` | Workers Builds (GitHub connector) on `main`, root directory `worker/` |

Notes:

- The pre-commit hook is the only test gate, and it runs locally. Nothing in
  CI re-runs tests before a deploy, so run the suites before pushing.
- Frontend and Worker deploy independently and not atomically. Make API changes
  backward compatible, or the new frontend can briefly hit the old Worker (or
  the reverse).
- Pages secrets: `WORKER_URL`, `READ_TOKEN`, optional `ORIGINALS_BASE_URL`,
  `ORIGINALS_TOKEN`. Worker secrets: `READ_TOKEN`, `INGEST_TOKEN`.
- D1 migrations are applied by the Worker build. Its deploy command is
  `npx wrangler d1 migrations apply DB --remote && npx wrangler deploy`, so
  merging a migration to `main` runs it on production, then deploys the code.
  Wrangler records applied migrations in D1, so each runs once and a retried
  build is harmless. If a migration fails, the deploy step does not run and the
  old Worker keeps serving.
  - Keep migrations additive (new columns/tables) so the old Worker still runs
    against the new schema between the migration and the deploy.
  - Review a destructive migration (a DROP or rebuild) carefully in the PR, and
    note a restore point first: `cd worker && npx wrangler d1 time-travel info DB`.
  - A build failing with Cloudflare API code 971 (rate limit) or 7403 is
    transient: wait about a minute and retry the build.
  - You can still apply one by hand beforehand with
    `cd worker && npx wrangler d1 migrations apply DB --remote`.
- Migrations `0009_people.sql` (faces and people) and `0010_faces_person_status_created_idx.sql` (an index) are additive and auto-apply on merge.
- Migration `0016_album_shares.sql` (`albums.owner_email`, `albums.shared_with`, `persons.owner_email`, lowercase triggers and the per-owner
  unique person-name index) is additive and auto-applies on merge. It also drops the old global `idx_persons_name_lower`
  (replaced by `idx_persons_owner_name_lower`); dropping an index is metadata-only, so no Time Travel bookmark is needed.
- Migration `0017_person_labels.sql` (the empty `person_labels` table, its unique index and triggers) is additive and auto-applies on
  merge: no backfill, no Time Travel bookmark needed. From then on a non-owner no longer receives the owner's person names.
- The agent is not deployed; it runs on your Mac.

### Rollout order for album sharing

There is no default owner: the Worker never reads `OWNER_EMAIL`. Pre-existing albums and people have no owner until you stamp
them, and an album with no owner (like a photo with no album) is visible to nobody. The Worker still returns 401 without
`X-Viewer-Email` and the Function 500 without its Access variables, by design (fail closed). So, in order:

1. Before merging, set Pages variables `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` (the Access application's audience tag), and
   `OWNER_EMAIL` in `agent/.env`. Pages and the Worker no longer need `OWNER_EMAIL`; delete the Worker secret if you set
   one (`cd worker && npx wrangler secret delete OWNER_EMAIL`) and the Pages variable.
2. Merge and let the Worker (migration `0016`, then code) and Pages Function deploy. The two deploy independently: if the
   Worker lands first, the old Function sends no `X-Viewer-Email` and the site answers 401 until the Pages deploy finishes (a
   short window).
3. Immediately run `cd worker && npm run backfill-owner` once. It reads `OWNER_EMAIL` from the environment or `agent/.env`,
   validates and lowercases it, and runs `UPDATE albums ... WHERE owner_email IS NULL` and the same for `persons` on the
   remote D1 through `wrangler d1 execute`. It is idempotent. `-- --dry-run` prints the SQL; `-- --local` targets the local
   D1; any other argument is refused. Until it runs, the owner sees nothing (a short window).
4. Update the agent and restart it: indexing now sends `ownerEmail` (it refuses to index without `OWNER_EMAIL`). An agent
   that has not been updated sends no `ownerEmail`, so `/ingest/photo` answers 400 (it is required). A running
   `serve-originals` breaks (its lookups get 401) until it is updated. `index-status` needs `OWNER_EMAIL` too.
5. Only then change the Cloudflare Access policy to allow any Google account. Doing it earlier lets strangers reach
   a Function that cannot yet verify them.

Local dev: the Vite `/api` proxy sends `X-Viewer-Email` from `DEV_VIEWER_EMAIL`, falling back to `OWNER_EMAIL` in the root
`.env`; set `DEV_VIEWER_EMAIL` to preview as a user an album is shared with. Run `cd worker && npm run backfill-owner -- --local`
to own your local albums.

### Rollout order for known personalities (phase 1)

1. Merge. The Worker build applies migration `0018_known_people.sql` (additive: one table, two nullable `faces` columns, one partial
   index) before the Worker deploys; the Pages Function deploys independently (it only adds the `people/known` read route).
2. On the owner's machine, from `agent/`: `known-check`, then `build-known-gallery` (reports how many people reach the gallery, at least
   3 openly licensed photos each), then `backfill-known --dry-run` (writes nothing; counts, per-person top 20, score histogram, sample
   face ids). Tune `KNOWN_THRESHOLD` (0.5) and `KNOWN_MARGIN` (0.05) in `agent/src/known/matcher.ts` from that output, then run
   `backfill-known`. Use `--rescore` after a threshold change, after removing a person from `people.json`, or after `--rebuild` of one
   (the Worker only writes rows that change, so a rescore costs reads of all faces but writes only the changed ones). If the embeddings
   route nears 10 ms CPU, lower the page size with `--page-size <n>` (1 to 100). `build-known-gallery` is incremental and remembers people
   with too few photos (`--retry-excluded` or `--rebuild <id>` retries them, `--full` starts over). Note: a rescan (`index-*`,
   `backfill-faces --recrop`) on a machine without the gallery file resets known matches on the rescanned unassigned and auto faces; run
   `backfill-known` to restore them.
3. Measure (all of this is unmeasured locally): start `cd worker && npx wrangler tail pixdex-worker --format json` before step 2 and
   watch `cpuTime` on `POST /ingest/faces/embeddings` (BLOB decode; lower the page `limit`, at most 100, with `backfill-known --page-size <n>` if it nears 10 ms) and
   `POST /ingest/faces/known`; time the whole backfill (estimate 1 to 3 minutes for about 5K photos); afterwards run
   `cd worker && npx wrangler d1 insights pixdex --timePeriod 1d --sort-type sum --sort-by reads --limit 12 --json` and check
   `GET /people/known` (its reads scale with the global count of known-matched faces) and the `known=` filter queries.
4. In a browser, check the People filter on Search and Timeline in light and dark mode (tests only ran in jsdom).

## D1 read budget

The free tier allows 5M rows read per day and every route past the limit returns 500 (`D1_ERROR: ... exceeded
D1's free tier daily row read limit`, resets at midnight UTC). See what is spending it with
`cd worker && npx wrangler d1 insights pixdex --timePeriod 1d --sort-type sum --sort-by reads --limit 12 --json`,
and measure a query with `wrangler d1 execute pixdex --remote --json --command "..."` (`meta.rows_read`).
Rules learned from that:

- A list of ids is looked up with `json_each(?) j CROSS JOIN faces f ON f.id = j.value`; `id IN (SELECT ... json_each)`
  next to a status filter made D1 scan every unassigned face (about 1,500 reads for a handful of ids).
- Per-photo queries on `faces` write `+assign_status` so the low-selectivity status index is not used.
- `UPDATE ... FROM <cte>` scans the table; update by `id IN (...)` with correlated lookups instead.
- The albums page aggregates once (a covering-index scan, `idx_photos_album_cover`, migration `0014`; `0013` was a
  no-op because `0001` already had `idx_photos_album`), then finds each page album's cover with index-ordered
  `LIMIT 1` lookups. Ranking every photo of the page's albums with a window function cost about 9k extra reads.
- `albums` (one row per album: count, cover photo and its thumbnail hash, newest date, average score) and
  `counters` (the `photos` total) are kept by triggers on `photos` and `album_covers` (migration `0015`), so the
  albums page, the album names list and the unfiltered search total read a few small rows instead of aggregating
  `photos`. Never write them from route code. Each photo write that changes album, date, `last_indexed` or a score
  re-aggregates just that album through `idx_photos_album_cover` (about one index entry per photo in the album);
  path-only updates (relocate) and face-scan updates do not fire it. The trigger SQL lives in
  `worker/migrations/albums.ts`; `0015_albums.sql` is generated from it with `cd worker && npm run gen:albums-migration`
  (a test fails if they drift). To add a column, add it in `albums.ts`, add an additive `ALTER TABLE` migration, and
  regenerate the triggers in a new numbered migration (triggers are `IF NOT EXISTS`, so drop and recreate them).
  Filtered searches still `COUNT(*)`. `idx_photos_last_indexed` serves the unfiltered newest-first list.
- The frontend keeps list data fresh for two minutes (`staleTime`), mutations invalidate what they change.

## Keeping docs current

After every feature or change, in the same commit or PR, update:

- `README.md`: setup, commands, env vars, project structure, user-facing behavior.
- `AGENTS.md`: layout, commands, rules, and the docs index.
- `docs/architecture.md` / this file when components, data flow, config, or
  workflow change.

New env vars go in the matching `.env.example` and the config table in
`docs/architecture.md`. If nothing doc-worthy changed, no update is needed.

## Conventions

- Strict TypeScript, ES modules everywhere.
- Frontend tests: Vitest + Testing Library; use `src/test/renderWithProviders.tsx`
  and `src/test/fixtures.ts`.
- DB changes: add the next numbered file under `worker/migrations/` and register
  it in `worker/migrations/index.ts`; add a test in `worker/test/schema.test.ts`
  when relevant.
- New Worker read route: add it to `worker/src/index.ts` with `requireReadToken`,
  and to the `ALLOWED_PATHS` allowlist in `functions/api/[[path]].ts`. A new
  browser write goes in that file's `WRITE_PATHS` for its method instead.
- Ingest routes stay out of the proxy allowlist.
- Plans and specs live in `docs/superpowers/plans` and `docs/superpowers/specs`.
- Backlog is `TODO.todo`.

## Running the agent

```bash
cd agent
npm run dev -- index-local "/path/to/folder"
npm run dev -- index-batch <roots...>   # resumable, see README
npm run dev -- index-status
npm run dev -- backfill-faces [folder]    # follows the index; needs the face sidecar, see agent/sidecar/README.md
npm run move-album -- <from> <to> [--dry-run] [--index-only]   # move an album folder and update the index
npm run dev -- serve-originals          # needs cloudflared, see agent/cloudflared/README.md
```

Face sidecar (optional, only needed for `backfill-faces` and face scanning during indexing):

```bash
pip install -r agent/sidecar/requirements.txt
python3 agent/sidecar/server.py   # 127.0.0.1:8799
```

Then set `FACE_SIDECAR_URL=http://127.0.0.1:8799` in `agent/.env`. Details and
licence note in `agent/sidecar/README.md`.

Requires Ollama running locally. See `README.md` for the batch indexer details,
EXIF backfill, and originals tunnel setup.

## Album sharing performance notes

CPU and D1 usage cannot be measured locally (no D1 row meters, no Workers CPU clock); the figures below are from
`EXPLAIN QUERY PLAN` (also asserted in `worker/test/query-plans.test.ts`) and reasoning, plus one Node timing for JWT
verification. Measure in production with `cd worker && npx wrangler tail pixdex-worker --format json` (cpuTime per
route) and `npx wrangler d1 insights pixdex --timePeriod 30d` (rows read per query), before and after the rollout.

There are no fast paths: every read is scoped for every user, the owner included. What that costs per request:

- Thumbnail (the hot path): one D1 read per request (was zero for the owner): `SEARCH p USING INDEX
  sqlite_autoindex_photos_2 (content_hash=?)` then `SEARCH va USING PRIMARY KEY (name=?)`, about 2 rows read. The
  response is `Cache-Control: private, max-age=31536000, immutable` (set by the Worker and the Function), so each browser
  asks once per photo. This is the one change that raises a hot-path cost; measure it with `wrangler tail` (cpuTime on
  `/thumbnails/:hash`) and `wrangler d1 insights`.
- Original: one Worker subrequest per original (`GET /access/photo/:id`, the same two primary-key searches, about 2 rows
  read) for the owner too.
- Lists (search, timeline, buckets, albums, daily pick): `album IN visibleAlbumsSql` where the subquery is
  `owner_email = ? OR EXISTS (json_each(shared_with))`. The OR means one pass over the small `albums` table (A rows,
  materialised once as `LIST SUBQUERY`), not an index search; `canEditFor` (`owner_email = ?`) does use the partial index
  (`SEARCH albums USING INDEX idx_albums_owner_email`), reading only the user's own albums. The `counters` total
  shortcut is skipped (those requests `COUNT(*)`), and search ordered by `date_time` loses its early exit and reads and
  sorts every visible row per page (see `TODO.todo`).
- Single photo (`GET /photos/:id`, `/photos/:id/faces`, `/faces/:id/crop`, `GET /access/photo/:id`): the primary-key join
  (`photoAccess`), about 2 rows read.
- Daily pick: the already-picked check, then at most 200 candidate rows (`PICK_CANDIDATES`, ordered so recently picked
  photos sort last) sorted in memory, for every user (the owner used to read the whole table here). One pick write, only
  when the chosen photo is in an album the user owns.
- Ingest: `POST /ingest/photo` adds one `albums` point read; the first photo of an album (or of an unowned one) adds one
  single-row `UPDATE albums SET owner_email` write, later photos add no write.
- People: `GET /people` scans the small `persons` table, with `idx_faces_person_status_created` per person and one photo
  primary-key lookup per counted face (the cover query reads visible assigned faces once). Person routes cost 1 `persons`
  primary-key read (plus, for a person you do not own, one bounded face probe) and the face routes one statement of three
  primary-key lookups per face. Name uniqueness is an index search on `idx_persons_owner_name_lower`. `/people/groups` and
  `/people/:id/match` candidate scans add two primary-key lookups per candidate face
  (`SEARCH ph USING INDEX sqlite_autoindex_photos_1 (id=?)`, `SEARCH a USING COVERING INDEX idx_albums_owner_email`) and
  keep rowid paging and the CPU budgets; groups short-circuits with one covering-index probe when the caller owns no
  album. Ingest auto-match loads references per owner (cached 60 s per owner) and shares the same MAC budget.
- Person labels: name resolution is `CASE WHEN p.owner_email = ? THEN p.name ELSE (SELECT name FROM person_labels WHERE viewer_email = ?
  AND person_id = p.id) END`, i.e. one primary-key probe (`SEARCH pl USING INDEX sqlite_autoindex_person_labels_1 (viewer_email=? AND
  person_id=?)`, asserted in `query-plans.test.ts`) per returned person or face row, only for rows the caller does not own, inside the
  existing statement (no extra round trip, no new scan). `PUT /people/:id/label` costs the `personRole` reads, one probe on
  `idx_person_labels_viewer_name_lower` and one upsert (1 row written); `DELETE` costs the same reads plus a 1-row delete.
  Deleting a person adds a trigger delete on `person_labels` (an index search on `idx_person_labels_person`). The table starts empty.
- `GET /me` is one request per session (`staleTime: Infinity`) with no D1 read.
- PATCH photo, album cover and share writes each add one `albums` primary-key read (`albumRole`); `PUT /albums/shares`
  also writes one `albums` row.
- JWT verification in the Function: about 43 microseconds warm per request with a cached JWKS (Node, 2000
  iterations); a cold isolate or the hourly expiry adds one certs fetch and key imports.

If rows read on search or timeline rise noticeably after other users exist, a different search ordering for scoped
requests or an `album_shares(email, album)` lookup table are the next steps.

### Security notes (hardening deferred from review)

- JWKS refetch has no negative cache: while the certs endpoint is failing, a forged-`kid` token can trigger a fetch
  (rate limited to one per minute for unknown kids on the rotation path, not on a cold isolate).
- The JWT `iss` claim is not checked (signature against the team JWKS plus `aud` already bind it to this app).
- No stale-JWKS grace: if the certs endpoint is down after the cache expires, every request is 401.
- The originals access subrequest to the Worker has no explicit timeout.
- A removed share can still show bytes already cached in the viewer's browser (originals `max-age=3600`, thumbnails
  immutable). Server-side access is revoked immediately.
- The Vite dev proxy forwards a client `X-Viewer-Email` when neither `DEV_VIEWER_EMAIL` nor `OWNER_EMAIL` (root `.env`) is set
  (dev only).
