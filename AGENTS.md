# PixdeX

Browse and search UI for a personal photo collection. A React frontend talks to
a Cloudflare Worker (D1 + R2); a separate local agent indexes photos with a
local Ollama model and pushes metadata and thumbnails to the Worker. Originals
never leave local disk or Google Drive.

## Layout

- `src/` - React 19 + Vite + Mantine frontend (calls same-origin `/api/*`);
  the `/ai-search` page (Chrome Prompt API only, client side): page in `src/components/AiSearch.tsx`, logic in
  `src/services/aiSearch/`, support gate in `src/hooks/usePromptApiSupport.ts`
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
- Known matching: `scanFaces` matches each kept face's embedding against the local gallery (`agent/.index-state/known-gallery.json`, loaded once per command by `src/known/loadKnownGallery.ts` and passed down as `gallery` / `knownGallery`; missing or corrupt means no matching, the corrupt case warns once) and posts `known: {id, score}` only for a confident match. A gallery built with a different face model than the detection warns once per run and posts no `known`; a face with an undecodable embedding is skipped. Cost is about 3.3 ms per face on the agent machine (405 people x 10 refs), local only.
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
- `POST /ingest/faces` accepts an optional `known: { id, score }` per face (agent-computed known-personality match); ids missing from
  `known_people` are dropped (one `json_each` lookup, only when a face has `known`). It is stored in `faces.known_id`/`known_score`,
  independent of `person_id`/`assign_status`; a kept confirmed face keeps its own values.
- `GET /people/known` (`worker/src/routes/known.ts`, READ_TOKEN plus `X-Viewer-Email`, not yet in the Pages proxy allowlist) lists known
  personalities with at least one matched face in a photo the viewer can see (`scopeFor`), `photoCount` = distinct visible photos. One
  grouped aggregate over `idx_faces_known_photo` (faces pinned as outer table with CROSS JOIN) plus one `json_each` name lookup.
- `known=<Q1,Q2>` on `/search`, `/timeline` and `/timeline/buckets` (`worker/src/db/known.ts`: `parseKnown`, `knownFilterSql`) is an AND
  filter: the photo needs a face matched to every id (with or without a person). It shares the cap of 5 with `people` (people take slots
  first, extra known ids are silently dropped), ids are bound, and the subquery walks `idx_faces_known_photo`; an unknown id is just zero results.
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
