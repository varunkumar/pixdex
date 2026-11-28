# PixdeX

Browse and search UI for a personal photo collection. A React frontend talks to
a Cloudflare Worker (D1 + R2); a separate local agent indexes photos with a
local Ollama model and pushes metadata and thumbnails to the Worker. Originals
are never stored on Cloudflare: they stay on local disk or Google Drive and are
fetched on demand, and viewers' browsers keep a copy of album cover originals
(for the album hero).

## Layout

Root, `worker/` and `agent/` are separate npm packages.

| Path | Contents |
|---|---|
| `src/` | React 19, Vite and Mantine frontend. It calls only `/api/*` on the same origin. |
| `dev/mockApi.ts` | Invented data for development only |
| `functions/` | Pages Functions: read proxy that adds the token, Access checks, enroll pages |
| `worker/` | Hono Worker: ingest and read API, D1 migrations, FTS5 search |
| `agent/` | Local Node and TypeScript indexer, originals server, `move-album` script |
| `agent/sidecar/` | Local Python services for faces and species. See its README. |
| `agent/known/` | Curated list of known people |
| `docs/` | Guides, agent notes, plans, specs, screenshots (dummy data only) |

## Feature notes (read before you change an area)

These files hold the detailed behavior, binding rules and measured costs. Read the applicable file first. If a change
touches two areas, read both.

| File | Read it before you change |
|---|---|
| [frontend](docs/agents/frontend.md) | UI layout, photo grids, Back navigation, search box, people filter |
| [albums](docs/agents/albums.md) | Album cover banner, framing, People and Species tabs, `/albums/contents`, `species=` |
| [access](docs/agents/access.md) | Access model, sharing, roles, write authorization, invites, `functions/` |
| [people](docs/agents/people.md) | People, faces, names, ignore, matching, auto-match review, face queries and indexes |
| [known](docs/agents/known.md) | Known personalities: gallery, agent commands, Worker routes, `known=` |
| [indexing](docs/agents/indexing.md) | Agent indexing, Google Drive, originals server, thumbnails, logs |
| [species](docs/agents/species.md) | Species sidecar, backfill, species ingest and search text |
| [insights](docs/agents/insights.md) | Dashboard facts, "On this day", `/insights/*`, their cache and camera time |

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
- `faces.person_id`, `faces.assign_status` and `faces.ignored_at` are owner/Worker decisions: the agent
  and ingest request bodies never set them (unknown keys are dropped). The Worker's
  own matching only ever writes `auto`; `confirmed` comes from the owner via the
  browser writes. Rejections live in `face_rejections`.
- In `worker/`, import zod as `import * as z from 'zod/mini'` (functional API, `z.flattenError(err)`), never from
  `'zod'`: the classic build adds about 450 KiB to the Worker bundle. `agent/` may use classic `zod`.
- DB changes go in a new numbered file in `worker/migrations/`.
- `albums` and `counters` are derived by triggers (`worker/migrations/albums.ts` generates
  `0015_albums.sql` via `cd worker && npm run gen:albums-migration`). Never write them from route code; change
  the generator and add a new numbered migration. Exception: the owner-edited `albums.owner_email`,
  `albums.shared_with` (migration `0016`) and `albums.cover_framing` (migration `0022`) are not derived. Only
  `PUT /albums/shares`, the first-photo stamp in `POST /ingest/photo` and the one-time
  `worker/scripts/backfill-owner.mjs` write the first two; only `PUT /albums/framing` writes `cover_framing`.
- After every feature or change, update the applicable files in the same commit: the guide in `docs/`, the notes
  in `docs/agents/`, and `README.md` only if its overview or quick setup changes. Change this file only for a new
  area, command or core rule. Write all docs in ASD-STE100.
- Do not commit `.env`, `credentials/`, or `agent/.index-state/`.

### Invariants

Do not break these. The feature notes give the reasons and the full rules.

Access and privacy:
- Scope every read to the viewer. An album that the viewer cannot see gives 404. A write by a viewer gives 403.
- Each non-ingest write checks authorization in its handler and uses `guardedWrite`. `POST /enroll` is the only exception.
- Store emails in lowercase and compare them exactly. There is no default owner and no special user.
- The Cloudflare Access group `pixdex-approved` is the only login gate. Album sharing does not give login access.
- Keep `CF_API_TOKEN` in Worker secrets only.
- Person names are private. Resolve them only with `PERSON_NAME_SQL`. Never select `p.name` raw.
- Do not call an external avatar service.

Faces and matching:
- New face queries that group, match or show faces must skip ignored faces.
- Do not change the face indexes, `INDEXED BY` or `+ignored_at` without measurements.
- In `MATCH_CANDIDATES_SQL`, keep the unary `+` and the CROSS JOINs. Keep the two match phases separate.
- Call `refreshReferences` after each write that changes confirmed faces.
- Auto-match review changes only faces that are still `auto` at write time. Do not add a "confirm all" for unseen faces.
- After a change to auto faces, call `markReviewQueueStale`. Do not refetch the review queue immediately.
- Frontend code queues match runs in `matchQueueFor`. Do not await `matchPersonAll` in a component.
- A known-person match is only a suggestion. It never sets `person_id` or `assign_status`.

Frontend:
- Hide controls that a user cannot use. Do not disable them.
- In the search box, one pick makes one URL update.
- Keep page numbers and filters in the URL, and other Back state in `useHistoryState`.

## Writing style

- Use [ASD-STE100 Simplified Technical English](https://en.wikipedia.org/wiki/Simplified_Technical_English) for all text:
  replies, docs, comments, commit messages and pull request descriptions. Do not change code, identifiers or quoted text.
- Use active voice and simple tenses. Put one idea in each sentence, and one instruction in each step.
- Use at most 20 words in an instruction sentence and 25 words in a descriptive sentence. Use one term for one thing.
- Do not use em dashes.
- Keep the README short: overview, features, quick setup and links. Put details in the guides in `docs/`, and link to them.
- Do not put implementation details in the opening description of the README.

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

`CLAUDE.md` contains only the `@AGENTS.md` import. Never add content to `CLAUDE.md`. Keep this file short (less than
2,000 words). Put core rules here and feature details in `docs/agents/`. This file must never have more than 200 lines.
The pre-commit hook enforces the limit. Do not raise it, and do not join lines to get below it.

## Docs

- [Architecture](docs/architecture.md): components, data flow, config and secrets
- [Development guide](docs/development.md): commands, hooks, deploys, conventions
- [Manual data updates](docs/manual-updates.md): safe one-off fixes to production D1 (for example album dates); read it before changing live data by hand
- [README](README.md): short overview and quick setup; details go in the guides below, not in the README
- Guides: [browse and review](docs/browsing.md), [search](docs/search.md), [indexing](docs/indexing.md),
  [people](docs/people.md), [sharing, access and originals](docs/sharing.md)
- Agent notes: `docs/agents/` (see "Feature notes")
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
