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
- The agent is not deployed; it runs on your Mac.

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
- The albums page aggregates once, then ranks covers only for the 12 albums on the page.
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
