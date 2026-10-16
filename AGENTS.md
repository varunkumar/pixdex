# PixdeX

Browse and search UI for a personal photo collection. A React frontend talks to
a Cloudflare Worker (D1 + R2); a separate local agent indexes photos with a
local Ollama model and pushes metadata and thumbnails to the Worker. Originals
never leave local disk or Google Drive.

## Layout

- `src/` - React 19 + Vite + Mantine frontend (calls same-origin `/api/*`)
- `functions/api/` - Cloudflare Pages Function: token-adding read proxy (also
  forwards the browser writes: `PUT albums/cover`, `PATCH photos/:id`,
  `PATCH`/`DELETE people/:id`, and `POST` to `people`, `people/:id/faces`,
  `people/:id/match`, `faces/:id/assign|reject|unassign`)
- `worker/` - Hono Worker: ingest + read API, D1 migrations, FTS5 search
- `agent/` - local Node/TS indexing CLI and originals server
- `docs/` - internal docs, plus `superpowers/` plans and specs

## Commands

Root, `worker/`, and `agent/` are separate npm packages.

- Frontend: `npm run dev`, `npm test`, `npm run lint`, `npm run build`
- Worker: `cd worker && npm test && npm run typecheck`
- Agent: `cd agent && npm test && npm run typecheck`

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
- DB changes go in a new numbered file in `worker/migrations/`.
- After every feature or change, update `README.md` and this file (and `docs/`
  if architecture, config or workflow changed) in the same commit.
- Do not commit `.env`, `credentials/`, or `agent/.index-state/`.

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
