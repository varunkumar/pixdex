# PixdeX

Browse and search UI for a personal photo collection. A React frontend talks to
a Cloudflare Worker (D1 + R2); a separate local agent indexes photos with a
local Ollama model and pushes metadata and thumbnails to the Worker. Originals
never leave local disk or Google Drive.

## Layout

- `src/` - React 19 + Vite + Mantine frontend (calls same-origin `/api/*`);
  the `/ai-search` page (Chrome Prompt API only, client side): page in `src/components/AiSearch.tsx`, logic in
  `src/services/aiSearch/`, support gate in `src/hooks/usePromptApiSupport.ts`
- `functions/api/` - Cloudflare Pages Function: token-adding read proxy (reads
  include `GET timeline` and `GET timeline/buckets`; also
  forwards the browser writes: `PUT albums/cover`, `PATCH photos/:id`,
  `PATCH`/`DELETE people/:id`, and `POST` to `people`, `people/:id/faces`,
  `people/:id/match`, `people/:id/cover`, `faces/:id/assign|reject|unassign`)
- `worker/` - Hono Worker: ingest + read API, D1 migrations, FTS5 search
- `agent/` - local Node/TS indexing CLI, originals server, and the `move-album` script
- `agent/sidecar/` - local Python InsightFace service (face detection and embeddings), see its README
- `docs/` - internal docs, plus `superpowers/` plans and specs and `screenshots/`
  (README images made from dummy data: gradient placeholders, no real photos or people)

## Commands

Root, `worker/`, and `agent/` are separate npm packages.

- Frontend: `npm run dev`, `npm test`, `npm run lint`, `npm run build`
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
- DB changes go in a new numbered file in `worker/migrations/`.
- `albums` and `counters` are derived by triggers (`worker/migrations/albums.ts` generates
  `0015_albums.sql` via `cd worker && npm run gen:albums-migration`). Never write them from route code; change
  the generator and add a new numbered migration.
- After every feature or change, update `README.md` and this file (and `docs/`
  if architecture, config or workflow changed) in the same commit.
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
