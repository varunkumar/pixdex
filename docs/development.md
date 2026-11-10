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
- Migration `0016_album_shares.sql` (`albums.owner_email`, `albums.shared_with`) is additive and auto-applies on merge.
- The agent is not deployed; it runs on your Mac.

### Rollout order for album sharing

The Worker now returns 401 without `X-Viewer-Email` and the Function returns 500 without its identity variables, by
design (fail closed). So:

1. Before merging, set Pages variables `OWNER_EMAIL`, `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` (the Access application's
   audience tag), and the Worker `OWNER_EMAIL` (secret or var).
2. Merge and let the Worker (migration `0016`, then code) and Pages Function deploy. Confirm the site still works for
   the owner.
3. Only then change the Cloudflare Access policy to allow any Google account. Doing it earlier lets strangers reach
   a Function that cannot yet verify them.
4. Set `OWNER_EMAIL` in `agent/.env` before running `serve-originals` (it exits without it) or `index-status`.

Local dev: the Vite `/api` proxy sends `X-Viewer-Email` from `DEV_VIEWER_EMAIL`, falling back to `OWNER_EMAIL`; set
`DEV_VIEWER_EMAIL` to preview as a user an album is shared with. Set `OWNER_EMAIL` in the Worker's local vars too.

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
`EXPLAIN QUERY PLAN` and reasoning, plus one Node timing for JWT verification. Measure in production with
`cd worker && npx wrangler tail pixdex-worker --format json` (cpuTime per route) and
`npx wrangler d1 insights pixdex --timePeriod 30d` (rows read per query), before and after the rollout.

- Default owner while no album has another owner: one small `SELECT EXISTS` over `albums` per scoped request (at
  most A rows, A is the number of albums, hundreds at most; no index on `owner_email`) and nothing else. The main
  query is unchanged and the `counters` total still applies. Thumbnails cost zero D1 queries for the default owner.
- Once another owner exists, scoped reads gain `album IS NULL OR album IN (subquery)` plus one scan of the small
  `albums` table (A rows, `json_each` over short `shared_with` arrays). Plans (seeded DB):
  - ids and timeline buckets stay index-only: `SEARCH photos USING COVERING INDEX idx_photos_album_cover (album=?)`
    (buckets no longer scan `idx_photos_date_time`, but still add a temp b-tree for GROUP BY).
  - search ordered by `date_time` loses the early exit: unscoped is `SCAN photos USING INDEX idx_photos_date_time`
    (stops at LIMIT); scoped is `SEARCH photos USING INDEX idx_photos_album (album=?)` plus
    `USE TEMP B-TREE FOR ORDER BY`, so it reads every visible row and sorts. This affects viewers and the default
    owner once another owner exists. Accepted: a viewer's visible set is bounded to the albums shared with them
    (ruling R4). FTS search is still driven by `photos_fts`, with the scope checked per candidate.
- The `counters` total shortcut is skipped whenever the scope is non-empty (those requests `COUNT(*)`).
- Non-default users pay one `UNIQUE(content_hash)` point lookup per thumbnail.
- Non-owner originals add one Worker subrequest (`GET /access/photo/:id`, one primary-key lookup plus scope).
- Viewer daily pick reads at most 200 candidate rows (`SHARED_CANDIDATES`) and sorts them in memory.
- `GET /me` is one request per session (`staleTime: Infinity`) with no D1 read.
- PATCH photo, album cover and share writes, and ingest with an album, each add one `albums` primary-key read
  (`albumRole`); `PUT /albums/shares` also writes one `albums` row.
- JWT verification in the Function: about 43 microseconds warm per request with a cached JWKS (Node, 2000
  iterations); a cold isolate or the hourly expiry adds one certs fetch and key imports.

If rows read on search or timeline rise noticeably after other users exist, an additive index on
`albums(owner_email)` or a different search ordering for scoped requests are the next steps.

### Security notes (hardening deferred from review)

- JWKS refetch has no negative cache: while the certs endpoint is failing, a forged-`kid` token can trigger a fetch
  (rate limited to one per minute for unknown kids on the rotation path, not on a cold isolate).
- The JWT `iss` claim is not checked (signature against the team JWKS plus `aud` already bind it to this app).
- No stale-JWKS grace: if the certs endpoint is down after the cache expires, every request is 401.
- The originals access subrequest to the Worker has no explicit timeout.
- A removed share can still show bytes already cached in the viewer's browser (originals `max-age=3600`, thumbnails
  immutable). Server-side access is revoked immediately.
- The Vite dev proxy forwards a client `X-Viewer-Email` when neither `DEV_VIEWER_EMAIL` nor `OWNER_EMAIL` is set
  (dev only).
