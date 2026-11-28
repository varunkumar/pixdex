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

Dev mock: `PIXDEX_MOCK=1 npm run dev` serves dummy `/api/*` data from `dev/mockApi.ts` (fictional people and known
personalities, albums, gradient SVG thumbnails that also stand in for originals, cover framing kept in memory) with no
`.env`, no secrets and no Worker, D1 or R2 traffic. It is
dev-server only (`vite.config.ts` reads the flag in Node), never imported by `src/`, so `npm run build` does not contain
it. Use it for browser checks of the omnibox, light and dark.

## Pre-commit gate

`.githooks/pre-commit` (enabled by root `npm install` via `core.hooksPath`) runs
only the suites touched by staged changes:

- `worker/` changes: worker tests
- `agent/` changes: agent typecheck + tests
- anything else: frontend lint, tests, build
- docs/markdown/todo-only commits skip the test suites
- all commits: the hook rejects an `AGENTS.md` with more than 200 lines

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
- Migration `0022_album_framing.sql` (the nullable `albums.cover_framing` column) is additive and auto-applies on merge. See
  "After deploying the browser-stored album hero" below.
- Migration `0024_insights_cache.sql` (the empty `insights_cache` table) is additive and auto-applies on merge.
- Migration `0025_photo_place.sql` (the nullable `photos.place` column) is additive and auto-applies on merge. Then run
  `backfill-places` on the agent computer (see [indexing](indexing.md)).
- The agent is not deployed; it runs on your Mac.

### After deploying the browser-stored album hero

Header images are no longer kept in R2: each browser stores the cover's original, and the `/heroes` routes are gone.

1. Wait until both the Pages and the Worker deploys have finished. They are independent, so for a short window an old page can
   show only the blurred thumbnail, or "Reposition" can fail to save.
2. Delete the `hero/` objects from the `pixdex-thumbnails` bucket by hand (Cloudflare dashboard: R2, `pixdex-thumbnails`, the
   `hero/` folder). Delete only that prefix: the same bucket holds the thumbnails, face crops and the known gallery backup. A
   deployment that never made a hero has nothing to delete.
3. Check an album page as the owner and as a viewer (the banner turns sharp, a reload requests no original, a saved framing
   shows for both). To measure, watch `cpuTime` on `GET /albums` and `PUT /albums/framing` with
   `cd worker && npx wrangler tail pixdex-worker --format json` (not measurable locally).

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
5. The Access policy step that used to be here ("allow any Google account") is superseded by invite-only access: do not open
   Access to every Google account. Follow "Rollout order for invite-only access" below instead (it switches the policy to
   the `pixdex-approved` group, never to everyone).

Local dev: the Vite `/api` proxy sends `X-Viewer-Email` from `DEV_VIEWER_EMAIL`, falling back to `OWNER_EMAIL` in the root
`.env`; set `DEV_VIEWER_EMAIL` to preview as a user an album is shared with. Run `cd worker && npm run backfill-owner -- --local`
to own your local albums.

### Rollout order for invite-only access

Spec: `docs/superpowers/specs/2026-11-14-invite-only-access-design.md`. The Access group is the only gate, so the order below
exists to keep the owner from being locked out. Use real addresses only in the dashboard and your shell, never in the repo.

1. In Zero Trust, create an Access group named `pixdex-approved` and add exactly two emails by hand: the admin and the one person
   albums are shared with today. Note the group's id (for `CF_ACCESS_GROUP_ID`).
2. Create a Cloudflare Turnstile widget for the site hostname. Set `TURNSTILE_SITE_KEY` (public) and `TURNSTILE_SECRET` as Pages
   variables. Without both, `/enroll` answers 503 and `POST /api/enroll` fails closed.
3. Create an Access application with a Bypass policy for exactly `/enroll` and `/api/enroll` (nothing wider: a wider bypass
   lets strangers reach the Function).
4. Create the API token with the single permission "Access: Organizations, Identity Providers, and Groups Write" (account scope, see
   below). Set the Worker secrets: `cd worker && npx wrangler secret put ADMIN_EMAIL` (same address as the agent's `OWNER_EMAIL`),
   then the same for `CF_API_TOKEN`, `CF_ACCOUNT_ID` and `CF_ACCESS_GROUP_ID`. Check the
   `namespace_id` of the `[[ratelimits]]` binding (`ENROLL_LIMITER`) in `worker/wrangler.toml`: 7410061 is a valid id; change it only if the account already has a rate limiter with that id. If it
   collided with another rate limiter in the account, the two would share one counter and throttle each other.
5. Merge. Migration `0019_access_requests.sql` (additive) applies before the new Worker goes live. The Access policy is still
   unchanged, so nothing is blocked yet.
6. Seed the existing users: `cd worker && npm run seed-access -- --dry-run`. It reads the REMOTE database read-only (a `SELECT` of
   `albums.owner_email` and `shared_with`, no write) and prints the addresses and the SQL. The CLI has not been run end to end by
   its implementers, so read the dry-run output carefully: it must list exactly the two addresses from step 1 (it refuses unless there
   are exactly two distinct ones; the admin address comes from `ADMIN_EMAIL`, `OWNER_EMAIL` or `agent/.env`). Then run
   `npm run seed-access` (an idempotent upsert: inserts two `approved` rows, upgrades a `pending` row for those two addresses to `approved`
   for anyone who enrolled before the seed ran, and leaves an existing approved, denied or revoked row untouched; `-- --local` targets the
   local D1). It writes
   `access_requests` only; the Access group is the one from step 1.
7. Only now switch the PixdeX Access application policy from "any Google account" to Allow: group `pixdex-approved`.
8. Verify: a Google account that is not in the group is blocked at the edge (no Function call); enroll through `/enroll` while
   signed out; approve it on `/admin/access` and sign in with it; revoke it and confirm its session ends at once.

Behaviour to know:

- A revoke calls two Cloudflare endpoints (remove from the group, then revoke sessions). If the second fails, the row stays
  `approved` although the email may already be out of the group; retry the revoke (both calls are idempotent).
- Concurrent approvals of different emails can lose a group update (read-modify-write on the group, one retry on a conflict). The
  admin page runs one action at a time; do not approve from two tabs at once.
- A concurrent revoke and approve from two browser tabs can re-add a revoked email (the group edit is GET-then-PUT). The UI runs one
  action at a time, but two tabs can still race. Recovery: revoke again.
- The admin page hides Revoke on the admin's own row; the Worker refuses it with 400 anyway.
- The public `POST /api/enroll` relays only the Worker's 202, 400 and 429; any other Worker status (401, 404, 500, ...) becomes a generic
  502 `Upstream unavailable`, so misconfiguration is never disclosed. `/enroll` answers 405 to every method but GET and HEAD.
- Local dev: the Vite dev proxy does not serve `/enroll` or `/api/enroll` (they are Pages Functions). The admin page works against the dev
  mock (`PIXDEX_MOCK=1 npm run dev`, which answers `/me` with `admin: true` and keeps requests in memory).
- Cannot be measured locally: Turnstile, the Cloudflare Access API, the Access bypass behaviour and the rate-limit binding. After
  deploy, measure with `wrangler tail` (Worker), the Access logs in Zero Trust, and an end-to-end check on the deployed site (the
  step 8 list, plus six enroll posts in a minute from one IP to see the 429).
- Cost: browse hot path unchanged. Enroll is one rate-limit binding call plus at most 1 indexed count over at most 200 pending rows
  plus at most 1 write (none for a duplicate or a full queue); admin list 2 statements, at most 200 rows; admin actions 1 read, 1 write,
  and Cloudflare calls: approve 2 (1 if already a member, 4 on a conflict retry), revoke 3 (2 if not a member, 5 with a retry), deny none;
  `/me` reads no D1.

### Rollout order for known personalities (phase 1)

1. Merge. The Worker build applies migration `0018_known_people.sql` (additive: one table, two nullable `faces` columns, one partial
   index) before the Worker deploys; the Pages Function deploys independently (it only adds the `people/known` read route).
2. On the owner's machine, from `agent/`: `known-check`, then `build-known-gallery` (reports how many people reach the gallery, at least
   3 openly licensed photos each), then `backfill-known --dry-run` (writes nothing; counts, per-person top 20, score histogram, sample
   face ids). Tune `KNOWN_THRESHOLD` (0.6) and `KNOWN_MARGIN` (0.05) in `agent/src/known/matcher.ts` from that output, then run
   `backfill-known`. Use `--rescore` after a threshold change, after removing a person from `people.json`, or after `--rebuild` of one
   (the Worker only writes rows that change, so a rescore costs reads of all faces but writes only the changed ones). If the embeddings
   route nears 10 ms CPU, lower the page size with `--page-size <n>` (1 to 100). `build-known-gallery` is incremental and remembers people
   with too few photos (`--retry-excluded` or `--rebuild <id>` retries them, `--full` starts over). Note: a rescan (`index-*`,
   `backfill-faces --recrop`) on a machine without the gallery file resets known matches on the rescanned unassigned and auto faces; run
   `backfill-known` to restore them.
   New machine: from `agent/` run `known-gallery-pull` once (or `build-known-gallery`, which restores the R2 backup `known/gallery.json` before it crawls anything), because `index-*` and `backfill-faces` never talk to R2. Back up explicitly with `known-gallery-push`. Existing local gallery and empty R2: just run `build-known-gallery`; an unchanged build checks R2 (one head) and pushes when no backup exists. Cost: one R2 put (about 11 MB) per changed build or first backup, one get per restore, one head per unchanged build, no D1, no Worker JSON work (Class A and Class B operations, a handful per month).
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

### Dashboard insights cost

See "Cost" in [the insights notes](agents/insights.md) for the numbers. After a release, measure production. Facts are
cached for up to 30 days, so only a part that is due is calculated. `wrangler d1 insights` is sampled: its totals are
not exact. For exact rows, run a query with `wrangler d1 execute` and read `meta.rows_read`.

```bash
cd worker
npx wrangler tail pixdex-worker --format json      # open the dashboard; read cpuTime of each /insights/ request
npx wrangler d1 insights pixdex --timePeriod 1d    # rows read of the insight statements
```

## Keeping docs current

After every feature or change, in the same commit or PR, update:

- `README.md`: short overview and quick setup only.
- `docs/browsing.md`, `search.md`, `indexing.md`, `people.md`, `sharing.md`:
  user-facing behavior, commands and setup. Write them in ASD-STE100.
- `AGENTS.md`: commands, core rules and the index of agent notes.
- `docs/agents/`: detailed agent notes for each area.
- `docs/architecture.md` / this file when components, data flow, config, or
  workflow change.

New env vars go in the matching `.env.example` and the config table in
`docs/architecture.md`. If nothing doc-worthy changed, no update is needed.

## Project structure

- `src/`: React interface. Search box in `components/omnibox` and
  `services/omnibox`. AI Search logic in `services/aiSearch`.
- `dev/mockApi.ts`: invented data for `PIXDEX_MOCK=1 npm run dev`.
- `functions/api`: proxy that adds the read token. `functions/_lib`: Access
  checks.
- `worker/`: Cloudflare Worker (Hono, D1, R2) and migrations.
- `agent/`: indexing CLI and originals server. `agent/sidecar/`: Python services.

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
npm run dev -- build-species-regions      # GBIF species lists per region (agent/species/regions.json), once
npm run dev -- backfill-species [--list] [--dry-run] [--album <name>]... [--limit <n>]   # follows the index (local and Drive); needs the species sidecar
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

Species sidecar (optional, for species during indexing and `backfill-species`):

```bash
pip install -r agent/sidecar/requirements-species.txt   # no virtualenv; may upgrade this Python's torch
python3 agent/sidecar/species_server.py                 # 127.0.0.1:8800
```

Then set `SPECIES_SIDECAR_URL=http://127.0.0.1:8800` in `agent/.env`. Migration `0020_species.sql`
(two columns on `photos`) deploys with the Worker like any other; the backfill needs the new Worker routes
live first. First backfill run: use `--limit 200` and check the D1 cost with `wrangler d1 insights` (the FTS
index rows rewritten per photo cannot be measured locally) before scaling up.

Requires Ollama running locally. See `README.md` for the batch indexer details,
EXIF backfill, and originals tunnel setup.

## Omnibox performance (Search, phase 2)

No Worker, D1, migration, agent or Pages Function change in this PR, so Worker CPU per invocation is unchanged (no new loops, JSON
or decoding there) and only the Pages deploy runs (the Cloudflare Deployments tab check for the Worker applies only when `worker/`
changes). The matcher runs in the browser: at most 12 words x a few hundred names, after a 150 ms debounce.

| Request | When | Rows (existing plans, unchanged) |
| --- | --- | --- |
| `GET /people`, `GET /people/known`, `GET /albums` | once per page load, cached 5 minutes, shared with Timeline (same query keys) | as today; Search did the same three loads before |
| `GET /search?...&limit=1` ("Add both" count) | one per distinct set of top matches, after each 150 ms pause in typing while two person spans are shown (so retyping can fire a new one for a new pair), cached by ids and filters, never per keystroke | one indexed filtered count; `known` uses `idx_faces_known_photo`, `people` the existing faces join; no `OFFSET`, no `COUNT(*)` beyond the `total` the route already returns |
| AI keyword `GET /search` calls | same count as before (one per keyword plus one library total) | each now also carries the active filters, which only narrows the scans |

In AI mode every chip added or removed (album, person, known, date) re-runs the whole pipeline: N keyword searches, one library
total and up to 150 thumbnail measures (each thumbnail is one D1 read through the scoped thumbnail route). That is no more calls
than a normal AI search, but filters now trigger a re-run where before only keyword or switch changes did. "Add keywords" (plain
mode, Prompt API only) just sets `mode=ai`; it makes no request until a keyword is entered, and never calls the model.

No new query shape: the count reuses the Phase 1 `/search` plans with `limit=1`. Not measurable locally: real D1 rows read and Worker
CPU for the count request. Measure after deploy with `cd worker && npx wrangler tail` (CPU time per `/search` while typing two
names, and the `limit=1` count) and `npx wrangler d1 insights DB`. The only added cost on any path is that on-demand count.

`EXPLAIN QUERY PLAN` of the count shape (album plus people, known and dates, against the test D1): no combination scans `photos` or
`faces`. `photos` uses `idx_photos_album_cover` (album and `date_time` range), people use `idx_faces_person_status_created`, known
uses the covering `idx_faces_known_shown` (it was `idx_faces_known_photo` before ignored faces); temp b-trees appear for the people `GROUP BY` and `count(DISTINCT)` and for the row
query's `ORDER BY`. The existing `scopeFor` visibility subquery scans `albums` plus `json_each(shared_with)` (albums is small).
`onThisDay` (`substr(date_time)`) is not indexable, so only `idx_photos_album` applies and cost follows the album's size. The
`COUNT(*)` that fills `total` covers every matching row, so `limit=1` does not make the count cheaper. The test D1 has no `ANALYZE`
statistics, so production plans may differ: confirm with `wrangler tail` and `wrangler d1 insights`.

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

### Ignored faces performance (migration 0021)

Measured locally in the Workers test runtime with 4,000 photos and 16,000 faces, each request run on the previous code,
on the new code, and on the previous code over the new schema, with and without `ANALYZE`:

- Rows read are identical to before on every face route while nothing is ignored, including the previous code on the new
  schema (the deploy window, or a rolled-back Worker).
- With 40% of unassigned faces ignored, the known list, filter and album views read fewer rows; a match page reads about
  4 to 8% more (it walks past ignored faces by rowid).
- Rows written rise, because the new partial indexes are maintained: about one more per face inserted or changing
  status, two with a known match. In the test, a five-face re-scan went from 53 to 66 rows written, confirming 10 faces
  from 40 to 51, and 50 known-match updates from 100 to 150.
- `POST /faces/ignore` and `/restore`: 2 statements, primary-key lookups only. `GET /people/ignored`: the owns-an-album
  probe plus one walk of `idx_faces_ignored`, no sort. Worker CPU: no new work over embeddings.
- The migration builds the indexes once (about one row written per face, plus one per known match).

Why the migration is additive: replacing `idx_faces_assign_status` with a partial index moved the people cover query to a
slower plan (about 29% more rows), and widening it made the groups page read many times more rows with statistics or on
the old code. Real D1 numbers are unmeasured: after deploy check `wrangler d1 insights pixdex` for rows read and
written on `faces`.

### Reviewing auto matches performance

Measured locally in the Workers test runtime with 5,000 photos and 25,497 faces (8,500 auto: 3,000 on one person,
530 on another; 715 confirmed, 5,503 ignored, 10,779 unnamed):

- `GET /people/:id/auto-faces` reads about 5 rows per auto face of that person, because the whole set is sorted by
  score on every page: a first page is 2,781 rows read at 530 faces and 15,070 at 3,000. 0 written.
- Paging through all of a person without changing anything: 12 pages and 20,646 rows read at 530; 63 pages and
  576,731 at 3,000 (about 12% of the free tier's daily 5M). Confirming or rejecting as you go removes faces from the
  set, so later pages read less. Plus `personRole` per request.
- `POST .../auto-faces/review`, 48 faces: confirm 432 rows read, 192 written; reject 672 read, 336 written (the
  rejection rows and the face updates); 48 faces that no longer qualify, 146 read, 0 written.
- Each review page also loads up to 48 face crops (one Function and Worker request and one R2 get each, cached by the
  browser for a day).
- Worker CPU: maps at most 48 rows; no embedding is read.
- No new index and no changed query, so other plans are unaffected. If a very large person makes the list too costly,
  the option is a partial index on `(person_id, match_score)` for auto faces, measured against the existing plans.

Real D1 numbers are unmeasured: after deploy check `wrangler d1 insights pixdex` and `wrangler tail`.

### Review queue performance

Measured locally in the Workers test runtime (16 people, 1,000 photos, plus 700 confirmed and 5,000 unnamed faces,
which the query does not touch):

| Pending auto faces | Rows read | Rows written |
|---|---|---|
| 0 | 18 | 0 |
| 530 | 2,671 | 0 |
| 3,000 | 14,898 | 0 |
| 8,500 | 42,123 | 0 |

- `GET /people/review-queue` is one statement, about 5 rows read per pending face. At 8,500 pending, 100 requests are
  about 84% of the free daily 5M, so it runs only for the People page, `/review` and the end of a review, is cached
  5 minutes in the browser, and changes only mark it stale (no immediate refetch). A reload requests it again.
- Worker CPU: at most one row per person. No migration, index or changed query.
- If it becomes too costly: a partial index on auto faces, or a count kept up to date on `persons`.

Real D1 numbers are unmeasured: check `wrangler d1 insights pixdex` after deploy.

### Person page faces performance

Measured in the local Workers test runtime: 48 photos with 3 faces each, one face per photo for the person.

| Read | Requests | D1 statements | Rows read | Rows written |
|---|---|---|---|---|
| Before: `GET /photos/:id/faces` for each photo | 48 | 96 | 527 | 0 |
| Now: `GET /people/:id/faces?photos=` | 1 | 1 | 336 | 0 |

The "before" row does not include the access check in the Pages Function for each request. Real D1 and CPU numbers are
not measured. After deploy, use `wrangler tail` and `wrangler d1 insights pixdex`. Just after a deploy, a new page can
reach the old Worker. It then shows "Could not load photo actions" until the Worker is updated.

### Matching references performance (migration 0023)

Measured locally in the Workers test runtime with 5,000 photos over 19 years and 16 people holding 716 confirmed faces
(largest 116), plus larger single people:

- Migration backfill: 6,012 rows read, 712 written.
- Loading references (match page, ingest at most once a minute per owner): 1,099 rows read for 356 references across
  all 16 people, 62 for one person. At most 30 embeddings per person are decoded, as before.
- A refresh after a change to confirmed faces: about 8 rows read per confirmed face of the affected people (954 at 116
  confirmed, 4,266 at 530, 24,026 at 3,000), about 7 when nobody is affected, 0 to 60 rows written, plus about 160 rows
  read by the two writing statements. 3 more D1 queries on that request.
- Confirming a 3,000-face person in 63 review pages would add roughly 750,000 rows read in the worst case (about 15%
  of the free tier's daily 5M), on top of the review itself. For 530 faces, about 25,000.

Real D1 numbers are unmeasured: after deploy check `wrangler d1 insights pixdex`.

### Security notes (hardening deferred from review)

- JWKS refetch has no negative cache: while the certs endpoint is failing, a forged-`kid` token can trigger a fetch
  (rate limited to one per minute for unknown kids on the rotation path, not on a cold isolate).
- The JWT `iss` claim is not checked (signature against the team JWKS plus `aud` already bind it to this app).
- No stale-JWKS grace: if the certs endpoint is down after the cache expires, every request is 401.
- The originals access subrequest to the Worker has no explicit timeout.
- A removed share can still show bytes already cached in the viewer's browser (originals `max-age=3600`, thumbnails
  immutable). Server-side access is revoked immediately.
- The album hero keeps cover originals in the viewer's IndexedDB with no expiry. A copy stays after access is revoked, until
  site data is cleared or the browser evicts it; the album page, the only thing that shows it, no longer loads for that user.
- The Vite dev proxy forwards a client `X-Viewer-Email` when neither `DEV_VIEWER_EMAIL` nor `OWNER_EMAIL` (root `.env`) is set
  (dev only).

## Cloudflare Access API token (invite-only access)

The Worker's `CF_API_TOKEN` (`worker/src/cf/accessApi.ts`) needs one account-scoped permission,
"Access: Organizations, Identity Providers, and Groups Write". It covers both `PUT /accounts/{id}/access/groups/{group}`
(add or remove an invited email) and `POST /accounts/{id}/access/organizations/revoke_user` (end a revoked user's sessions).
Called only from owner-only admin routes: 2 Cloudflare subrequests per add or remove (1 when the group needs no change, 4 with one
conflict retry), 1 per session revoke, no D1.
