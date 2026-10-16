# Faces and People (phase A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect and embed faces locally, let the owner name a face once (from a photo or from a People page), match that person automatically across the library (existing and newly indexed photos), and correct wrong matches.

**Architecture:** A Python sidecar (InsightFace `buffalo_l`) runs on the owner's Mac; the Node agent sends it a 1280 px JPEG per photo and pushes the returned faces (normalised bbox + 512-d vector) to a new `/ingest/faces` route. The Worker stores faces in D1 and matches them automatically in a shared matching module (best cosine over a person's confirmed faces): when a photo's faces are ingested, and, in pages of 300 faces (150 for groups), when you name a face. Only find-similar (phase B) is on demand. The browser only ever sees face ids, boxes, person ids and scores, never vectors.

**Tech Stack:** Hono + D1 + zod (Worker), Node/TS + sharp (agent), Python + insightface + onnxruntime (sidecar), React 19 + Mantine + TanStack Query (frontend), vitest everywhere.

**Spec:** `docs/superpowers/specs/2026-10-16-image-vectors-and-people-design.md` (phase A only; phase B, image vectors and find-similar, is a separate plan).

## Global Constraints

- Free Cloudflare tier only, free features only. No Vectorize, Workers AI, Queues.
- Originals never leave local disk or Google Drive. Face vectors never reach the browser.
- Face vector: 512 float32, little-endian, L2-normalised; stored as BLOB; `embedding_model` is `buffalo_l`.
- Thresholds in one module (`worker/src/people/matching.ts`): `AUTO_THRESHOLD = 0.5`, `SUGGEST_THRESHOLD = 0.4`, `FACE_PAGE_SIZE = 300` (matching) and `GROUPS_PAGE_SIZE = 150` (groups), `REFERENCES_PER_PERSON = 30` (the 30 newest confirmed faces of a person), `MIN_DET_SCORE = 0.6`, `MIN_FACE_SIDE = 0.03` (normalised box side).
- Matching reads only the `faces` table (photos with detected faces) and only faces with `det_score >= MIN_DET_SCORE` and `bbox_w, bbox_h >= MIN_FACE_SIDE`. Weaker faces stay stored and nameable by hand but are excluded from automatic matching, groups and suggestions.
- `assign_status` is `unassigned`, `auto` or `confirmed`. Only the browser-facing routes set `confirmed`; the Worker's own matching sets `auto` when a score clears `AUTO_THRESHOLD` (at ingest and in `POST /people/:id/match` with `apply`); request bodies on `/ingest/*` and the agent never supply `person_id` or `assign_status`. A `confirmed` face is never changed by matching or by re-ingest.
- Only `confirmed` faces are references. Suggestions (score between 0.4 and 0.5) are returned, never stored.
- `/ingest/*` stays out of the Pages proxy allowlist. READ_TOKEN, INGEST_TOKEN, ORIGINALS_TOKEN never reach the browser.
- DB changes: one new numbered, additive migration `worker/migrations/0009_people.sql`, mirrored in `worker/migrations/index.ts`.
- Never use em dashes in code, comments, docs or commit messages.
- Pre-commit hook must pass; do not bypass. Run `graphify update .` after code changes. Update `README.md`, `AGENTS.md` and `docs/` in the same change as the feature.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; the PR body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Review Focus

Each line below has a test in the named task.

1. A wildlife photo with no faces: scanned marker set, zero rows, not offered again by `faces/pending` (Task 3).
2. Re-ingesting a photo whose face the owner already confirmed: the confirmed row survives, the same face is not duplicated (Task 3).
3. A face rejected for person X never comes back as a match or suggestion for X, even after re-ingest and re-match; and a new photo of a named person is auto-matched at ingest, while a photo with no faces loads no references (Tasks 5 and 5b).
4. Deleting a person returns its faces to `unassigned` and drops its rejections; a rename to an existing name (any case) is refused with 409 (Task 4).
5. Matching a person with no confirmed faces, or with nothing left to match, returns empty lists, not an error (Task 5).

## File Structure

Worker (`worker/`):
- `migrations/0009_people.sql`, `migrations/index.ts` (mirror): tables and the `photos.faces_scanned_model` column.
- `src/people/embedding.ts`: encode and decode face vectors (base64 and BLOB).
- `src/people/matching.ts`: thresholds, `dot`, `bestScore`, `classify`, `clusterFaces`.
- `src/people/references.ts`, `src/people/autoMatch.ts`: `loadReferences` (shared by ingest-time matching and the match route) and `autoMatchFaces`.
- `src/db/faces.ts`: `FaceRow`, `SerializedFace`, `serializeFace`, `FACE_SELECT`.
- `src/routes/ingest-faces.ts`: `/ingest/faces` and `/ingest/faces/pending`.
- `src/routes/people.ts`: people CRUD, bulk assign, groups, match.
- `src/routes/faces.ts`: per-face assign, reject, unassign, and `GET /photos/:id/faces`.
- `src/routes/search.ts`: `people` filter.
- `src/index.ts`: route registration.

Proxy: `functions/api/[[path]].ts`.

Agent (`agent/`): `sidecar/` (Python), `src/faces/sidecarClient.ts`, `src/faces/scanFaces.ts`, `src/backfillFaces.ts`, edits to `cloudflareClient.ts`, `config.ts`, `processFile.ts`, `cli.ts`.

Frontend (`src/`): `types/api.ts`, `services/api/WorkerApiClient.ts`, `components/FaceTile.tsx`, `components/PhotoFaces.tsx`, `components/People.tsx`, `components/PersonPage.tsx`, edits to `PhotoDetail.tsx`, `Search.tsx`, `Layout.tsx`, `App.tsx`.

---

### Task 1: Schema migration

**Files:**
- Create: `worker/migrations/0009_people.sql`
- Modify: `worker/migrations/index.ts` (append mirrored statements to `EXIF_MIGRATION_STATEMENTS`)
- Test: `worker/test/schema.test.ts`

**Interfaces:**
- Produces: tables `persons(id, name, created_at)` with a unique index on `lower(name)`; `faces(id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, det_score, embedding BLOB, embedding_model, person_id, assign_status, match_score, created_at)`; `face_rejections(face_id, person_id)` primary key on the pair; `photos.faces_scanned_model TEXT`. bbox values are normalised 0..1 of the image width and height. Indexes on `faces(photo_id)`, `faces(person_id)`, `faces(assign_status)`.

- [ ] **Step 1: Failing tests** in `schema.test.ts`: `people schema accepts a face and enforces unique person names case-insensitively` (insert "Priya" then "priya" fails), `face_rejections primary key rejects a duplicate pair`, `faces.assign_status defaults to unassigned and rejects an unknown status` (a CHECK constraint).
- [ ] **Step 2: Run** `cd worker && npx vitest run test/schema.test.ts`. Expect FAIL (no such table).
- [ ] **Step 3: Write the migration** with `CREATE TABLE IF NOT EXISTS` and the `ALTER TABLE photos ADD COLUMN faces_scanned_model TEXT;`; mirror every statement, one per array element, in `index.ts` with a "Mirrors 0009_people.sql" comment.
- [ ] **Step 4: Run** the worker suite: `cd worker && npm test`. Expect PASS.
- [ ] **Step 5: Commit** `feat(worker): people and faces schema`.

---

### Task 2: Embedding codec and matching module

**Files:**
- Create: `worker/src/people/embedding.ts`, `worker/src/people/matching.ts`
- Test: `worker/test/people-matching.test.ts`

**Interfaces:**
- Produces (`embedding.ts`):
  - `const EMBEDDING_DIM = 512`
  - `embeddingFromBase64(b64: string): Float32Array` (throws `Error('invalid embedding')` unless it decodes to exactly 512 floats; returns the vector L2-normalised)
  - `embeddingToBytes(v: Float32Array): Uint8Array` and `embeddingFromBytes(b: ArrayBuffer | Uint8Array): Float32Array` (little-endian float32, round-trips exactly)
- Produces (`matching.ts`):
  - `const AUTO_THRESHOLD = 0.5`, `SUGGEST_THRESHOLD = 0.4`, `FACE_PAGE_SIZE = 300` (matching) and `GROUPS_PAGE_SIZE = 150` (groups), `REFERENCES_PER_PERSON = 30`, `MIN_DET_SCORE = 0.6`, `MIN_FACE_SIDE = 0.03`
  - `isMatchable(face: { detScore: number; w: number; h: number }): boolean` (the quality rule above)
  - `dot(a: Float32Array, b: Float32Array): number`
  - `bestScore(face: Float32Array, refs: Float32Array[]): number` (max dot; `-1` when `refs` is empty)
  - `classify(score: number): 'auto' | 'suggest' | 'none'` (`>= 0.5` auto, `>= 0.4` suggest)
  - `clusterFaces(faces: { id: string; embedding: Float32Array }[]): string[][]` (greedy: join the cluster whose best link is highest and `>= SUGGEST_THRESHOLD`, else start a new one; clusters sorted by size, largest first)

- [ ] **Step 1: Failing tests:** `base64 round trip keeps the vector`, `rejects a vector of the wrong length`, `normalises on decode` (norm within 1e-6), `bytes round trip is exact`, `classify at 0.5 is auto, at 0.4 is suggest, at 0.399 is none`, `bestScore takes the maximum over references and returns -1 for none`, `clusterFaces groups two close vectors and separates an orthogonal one`, `clusterFaces returns the larger group first`, `isMatchable rejects a low score and a tiny box and accepts a normal face`, `MATCHABLE_SQL uses the same constants`.
- [ ] **Step 2: Run** `cd worker && npx vitest run test/people-matching.test.ts`. Expect FAIL (module not found).
- [ ] **Step 3: Implement** both modules, plain TypeScript, no dependencies; `Buffer` is not available in Workers, so decode base64 with `atob`.
- [ ] **Step 4: Run** the same file. Expect PASS.
- [ ] **Step 5: Commit** `feat(worker): face embedding codec and matching module`.

---

### Task 3: Face ingest routes

**Files:**
- Create: `worker/src/routes/ingest-faces.ts`, `worker/src/db/faces.ts`
- Modify: `worker/src/index.ts` (register under the existing `/ingest/*` token middleware)
- Test: `worker/test/ingest-faces.test.ts`

**Interfaces:**
- Consumes: `embeddingFromBase64`, `embeddingToBytes` (Task 2).
- Produces (`db/faces.ts`):
  - `interface FaceRow` (raw columns) and `interface SerializedFace { id: string; photoId: string; thumbnailUrl: string; bbox: { x: number; y: number; w: number; h: number }; detScore: number; personId: string | null; personName: string | null; status: 'unassigned' | 'auto' | 'confirmed'; matchScore: number | null }`
  - `serializeFace(row: FaceRow & { person_name: string | null; content_hash: string }): SerializedFace` (thumbnail URL is `/thumbnails/<content_hash>`, the same form `serializePhoto` uses; the embedding is never included)
  - `FACE_SELECT: string`, the shared SELECT joining `photos` (content hash) and `persons` (name), selecting no embedding.
- Produces (routes):
  - `POST /ingest/faces/pending` body `{ hashes: string[]; model: string }` returns `{ pending: string[] }`: hashes that exist in `photos` and whose `faces_scanned_model` differs from `model`. Unknown hashes are omitted.
  - `POST /ingest/faces` body `{ contentHash: string; model: string; faces: { bbox: {x,y,w,h}; detScore: number; embedding: string }[] }` returns `{ stored: number; kept: number }`. 404 for an unknown hash, 400 for a bad body or embedding.

- [ ] **Step 1: Failing tests** (follow `ingest-exif.test.ts` for setup and auth): `rejects a missing or wrong ingest token`, `pending lists only indexed, unscanned hashes`, `stores faces unassigned and marks the photo scanned`, `a photo with no faces is marked scanned and no longer pending` (Review Focus 1), `re-ingest replaces unassigned and auto faces`, `re-ingest keeps a confirmed face and does not duplicate it` (a new face with IoU >= 0.5 against a confirmed one is dropped; Review Focus 2), `ignores person_id or assign_status sent in the body`, `400 for an embedding of the wrong length`, `404 for an unknown content hash`. One test also reads the stored BLOB back through `embeddingFromBytes` to confirm D1 returns it in a decodable form.
- [ ] **Step 2: Run** `cd worker && npx vitest run test/ingest-faces.test.ts`. Expect FAIL (404 on the routes).
- [ ] **Step 3: Implement** `serializeFace`, `FACE_SELECT`, and both routes with zod; ids are `crypto.randomUUID()`. Re-ingest deletes the photo's `unassigned` and `auto` rows, inserts the new ones except those overlapping a `confirmed` face, then sets `faces_scanned_model`. Use `DB.batch` so it is one round trip.
- [ ] **Step 4: Run** the worker suite and `npm run typecheck`. Expect PASS.
- [ ] **Step 5: Commit** `feat(worker): ingest faces and pending-scan routes`.

---

### Task 4: People and face management routes

**Files:**
- Create: `worker/src/routes/people.ts` (people CRUD, bulk assign), `worker/src/routes/faces.ts` (per-face actions, `GET /photos/:id/faces`)
- Modify: `worker/src/index.ts`
- Test: `worker/test/people.test.ts`

**Interfaces:**
- Consumes: `FACE_SELECT`, `serializeFace`, `SerializedFace` (Task 3).
- Produces (all behind `requireReadToken`):
  - `GET /people` returns `{ people: { id: string; name: string; faceCount: number; photoCount: number; cover: SerializedFace | null }[] }` (counts over `confirmed` and `auto` faces; cover is the highest-`det_score` confirmed face; sorted by `faceCount` desc then name).
  - `POST /people` body `{ name: string; faceIds?: string[] }` returns 201 `{ id, name }`; with `faceIds`, those faces become `confirmed` for the new person. 409 on a duplicate name (case-insensitive). Name is trimmed, 1 to 60 chars.
  - `PATCH /people/:id` body `{ name }` (409 on duplicate), `DELETE /people/:id` (faces back to `unassigned` with `person_id` and `match_score` cleared, rejections for that person deleted).
  - `POST /people/:id/faces` body `{ faceIds: string[] }` (max 200) sets `confirmed`.
  - `POST /faces/:id/assign` body `{ personId }` sets `confirmed`, clears `match_score`, deletes a rejection for that pair; returns `SerializedFace`.
  - `POST /faces/:id/reject` body `{ personId }` inserts into `face_rejections`; if the face is currently assigned to that person it returns to `unassigned`; returns `SerializedFace`.
  - `POST /faces/:id/unassign` returns the face to `unassigned`.
  - `GET /photos/:id/faces` returns `{ faces: SerializedFace[] }`, ordered by bbox_x. Register it before the existing `app.get('/photos/:id', ...)` pattern conflicts (they are different paths, check ordering).

- [ ] **Step 1: Failing tests:** create, list with counts and cover, duplicate name 409 including `priya` vs `Priya`, rename, rename to an existing name 409, `delete returns faces to unassigned and drops rejections` (Review Focus 4), bulk assign confirms faces, `assign overrides an auto assignment and clears the rejection`, `reject removes an auto assignment and records the rejection`, `unassign`, `photo faces response never contains an embedding field`, `404 for an unknown face or person`, `401 without the read token`.
- [ ] **Step 2: Run** `cd worker && npx vitest run test/people.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** routes with zod bodies; register `app.use('/people/*', requireReadToken)`, `app.use('/people', requireReadToken)` and `app.use('/faces/*', requireReadToken)`.
- [ ] **Step 4: Run** the worker suite and typecheck. Expect PASS.
- [ ] **Step 5: Commit** `feat(worker): people and face assignment routes`.

---

### Task 5: Groups and on-demand matching

**Files:**
- Modify: `worker/src/routes/people.ts`
- Test: `worker/test/people-match.test.ts`

**Interfaces:**
- Consumes: `bestScore`, `classify`, `clusterFaces`, `FACE_PAGE_SIZE`, `GROUPS_PAGE_SIZE` (Task 2); `embeddingFromBytes`; `serializeFace`.
- Produces:
  - `GET /people/groups?cursor=<rowid>` returns `{ groups: { faces: SerializedFace[] }[]; scanned: number; nextCursor: string | null }`. Loads up to `GROUPS_PAGE_SIZE` (150) `unassigned` faces that satisfy `MATCHABLE_SQL`, with `rowid > cursor` (ordered by rowid), clusters them, groups of one are included last. `nextCursor` is the last rowid when the page was full, else null.
  - `POST /people/:id/match` body `{ apply?: boolean; cursor?: string }` returns `{ auto: SerializedFace[]; suggestions: SerializedFace[]; scanned: number; nextCursor: string | null }`. References are the person's `confirmed` faces via `loadReferences(db, { personId })` (implement it in `src/people/references.ts` in this task; Task 5b reuses it). Candidates are one page of `unassigned` faces plus `auto` faces assigned to a different person (both filtered with `MATCHABLE_SQL`), minus faces rejected for this person. An `auto` face of another person is only taken when the new score exceeds its `match_score`. `classify` decides auto vs suggestion. With `apply: true` the auto set is saved (`assign_status = 'auto'`, `person_id`, `match_score`); suggestions are never saved. No references or no candidates returns empty lists with 200.

- [ ] **Step 1: Failing tests** using hand-made unit vectors inserted through the ingest route: `groups clusters similar unassigned faces and ignores assigned ones`, `groups pages with a cursor`, `match returns auto and suggestion buckets by threshold` (scores 0.6 auto, 0.45 suggestion, 0.2 neither), `match without apply writes nothing`, `match with apply saves only auto matches and never suggestions`, `match never overwrites a confirmed face`, `match skips a face rejected for this person` (Review Focus 3, including after re-ingest of the photo), `match takes an auto face from another person only on a higher score`, `match for a person with no confirmed faces returns empty lists` (Review Focus 5), `match with nothing unassigned returns empty lists`, `groups and match skip a face below the quality rule but the photo page still lists it`, `match uses the best score over several references` (the age case: a child matches the closest of several reference faces).
- [ ] **Step 2: Run** `cd worker && npx vitest run test/people-match.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** both routes; the `groups` route must be registered before `/people/:id` style patterns so `groups` is not read as an id. Keep all scoring in `matching.ts`.
- [ ] **Step 4: Run** the worker suite and typecheck. Also run one test with 300 candidate faces to confirm it finishes quickly under the pool-workers runtime; record the observed time in the PR description (the free-tier CPU limit is unmeasured in the spec).
- [ ] **Step 5: Commit** `feat(worker): face groups and on-demand person matching`.

---

### Task 5b: Automatic matching at ingest

**Files:**
- Create: `worker/src/people/autoMatch.ts` (and `worker/src/people/references.ts` if Task 5 did not already create it)
- Modify: `worker/src/routes/ingest-faces.ts`, `worker/src/routes/people.ts` (use the shared `loadReferences`)
- Test: `worker/test/auto-match.test.ts`

**Interfaces:**
- Consumes: `bestScore`, `classify`, `REFERENCES_PER_PERSON` (Task 2); `embeddingFromBytes`.
- Produces:
  - `loadReferences(db: D1Database, opts?: { personId?: string }): Promise<{ personId: string; vectors: Float32Array[] }[]>`: for each person (or one), the `REFERENCES_PER_PERSON` newest `confirmed` faces' vectors; people with none are omitted.
  - `autoMatchFaces(db: D1Database, faceIds: string[]): Promise<number>`: for each given `unassigned` face that passes `isMatchable`, finds the person with the highest `bestScore`; when `classify(score) === 'auto'` and the pair is not in `face_rejections`, sets `assign_status = 'auto'`, `person_id`, `match_score`. Returns the number matched. Loads no references when `faceIds` is empty.
  - `POST /ingest/faces` calls `autoMatchFaces` with the ids it just inserted and returns `{ stored, kept, matched }`.

- [ ] **Step 1: Failing tests:** `a new face close to a named person is saved as auto with its score`, `a new face below the threshold stays unassigned`, `a tiny or low-score face is stored but never auto-matched`, `the best of several persons wins`, `a rejected pair is not re-attached after re-ingest`, `a confirmed face is untouched when the photo is re-ingested`, `a photo with no faces loads no references` (spy that no query on confirmed faces is made), `only the newest 30 confirmed faces per person are used` (31 confirmed, the oldest is the only close one, no match), `ingest response includes matched`.
- [ ] **Step 2: Run** `cd worker && npx vitest run test/auto-match.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the module and wire the ingest route; the match route and this module share `loadReferences`, with no second copy of the scoring loop.
- [ ] **Step 4: Run** the worker suite and typecheck. Expect PASS.
- [ ] **Step 5: Commit** `feat(worker): match new faces to named people at ingest`.

---

### Task 6: "Together" filter on search

**Files:**
- Modify: `worker/src/routes/search.ts`
- Test: `worker/test/search.test.ts` (add cases)

**Interfaces:**
- Produces: `GET /search?people=<id>,<id>` keeps only photos that have at least one `auto` or `confirmed` face for every listed person (all of them, not any). Works together with `q`, `album`, `sort`, and the count query.

- [ ] **Step 1: Failing tests:** `people filter keeps photos containing all listed persons`, `people filter counts auto and confirmed faces but not unassigned`, `people filter combines with q and album`, `an unknown person id returns no results`, `total reflects the filter`.
- [ ] **Step 2: Run** `cd worker && npx vitest run test/search.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** an extra `AND photos.id IN (SELECT photo_id FROM faces WHERE person_id IN (...) AND assign_status IN ('auto','confirmed') GROUP BY photo_id HAVING COUNT(DISTINCT person_id) = ?)` clause with bound parameters in `run()`, cap the list at 5 ids.
- [ ] **Step 4: Run** the worker suite. Expect PASS.
- [ ] **Step 5: Commit** `feat(worker): filter search by people`.

---

### Task 7: Pages proxy for the new routes

**Files:**
- Modify: `functions/api/[[path]].ts`
- Test: add a test beside the existing front-end tests only if the root vitest config can include `functions/` (check `vite.config.ts` `test.include`); otherwise cover it by a small exported pure function `isAllowed(method, path)` tested from `src/`.

**Interfaces:**
- Produces:
  - GET allowlist adds `^people$`, `^people\/groups$`, `^photos\/[^/]+\/faces$`.
  - New `onRequestPost` allowing exactly: `people`, `people/<id>/faces`, `people/<id>/match`, `faces/<id>/assign`, `faces/<id>/reject`, `faces/<id>/unassign`. JSON only (415 otherwise), same header and cookie handling as the existing PUT and PATCH handlers.
  - `onRequestPatch` also allows `people/<id>`; new `onRequestDelete` allows `people/<id>` only.
  - `/ingest/*` is still not reachable (add an explicit test that GET and POST on `ingest/faces` return 404).

- [ ] **Step 1: Failing tests:** allowed and disallowed paths per method, `ingest/faces` 404, non-JSON POST 415.
- [ ] **Step 2: Run** the root suite `npm test`. Expect FAIL.
- [ ] **Step 3: Implement.** Factor the repeated forward-and-sanitise block into one helper rather than copying it a fourth and fifth time.
- [ ] **Step 4: Run** `npm test && npm run lint`. Expect PASS.
- [ ] **Step 5: Docs:** update the "browser writes" wording in `AGENTS.md` (Layout line), `README.md` and `docs/architecture.md` to list the new browser writes. Commit `feat(proxy): forward people and face routes`.

---

### Task 8: Python face sidecar

**Files:**
- Create: `agent/sidecar/server.py`, `agent/sidecar/requirements.txt`, `agent/sidecar/README.md`

**Interfaces:**
- Produces: a local HTTP service on `127.0.0.1:8799` (port from `PIXDEX_SIDECAR_PORT`).
  - `GET /health` returns `{"ok": true, "model": "buffalo_l"}`.
  - `POST /faces` with a JPEG as the body returns `{"model": "buffalo_l", "width": int, "height": int, "faces": [{"bbox": [x1, y1, x2, y2], "detScore": float, "embedding": "<base64 of 512 little-endian float32, L2-normalised>"}]}` with bbox in pixels of the image it received. Invalid image returns 400.
  - Uses `insightface.app.FaceAnalysis(name='buffalo_l', providers=['CoreMLExecutionProvider','CPUExecutionProvider'])`, `det_size=(640, 640)`, and `normed_embedding`. Standard library `http.server` only, no web framework.

- [ ] **Step 1: Write the server**, one file under about 80 lines.
- [ ] **Step 2: Set up and run** (documented in its README): `uv venv --python 3.12 agent/sidecar/.venv`, `uv pip install -r agent/sidecar/requirements.txt`, `python server.py`. Add `agent/sidecar/.venv/` and `__pycache__/` to `.gitignore`.
- [ ] **Step 3: Verify by hand:** `curl -s localhost:8799/health`, then `curl -s --data-binary @<a Bandipur photo with a person> localhost:8799/faces | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['faces']), len(d['faces'][0]['embedding']))"`. Expect 1 face and an embedding string of length 2732 (2048 bytes in base64).
- [ ] **Step 4: Commit** `feat(agent): InsightFace sidecar`.

---

### Task 9: Agent client, scan, backfill and CLI

**Files:**
- Create: `agent/src/faces/sidecarClient.ts`, `agent/src/faces/scanFaces.ts`, `agent/src/backfillFaces.ts`
- Modify: `agent/src/cloudflareClient.ts`, `agent/src/config.ts`, `agent/src/processFile.ts`, `agent/src/cli.ts`
- Test: `agent/test/sidecarClient.test.ts`, `agent/test/scanFaces.test.ts`, `agent/test/backfillFaces.test.ts`, additions to `cloudflareClient.test.ts`, `config.test.ts`, `processFile.test.ts`, `cli.test.ts`

**Interfaces:**
- Produces:
  - `config`: optional `FACE_SIDECAR_URL` (url), no default; face scanning is off when unset.
  - `FaceSidecarClient`: `constructor(baseUrl: string, fetchFn?: typeof fetch)`, `detect(jpeg: Buffer): Promise<{ model: string; width: number; height: number; faces: { bbox: [number, number, number, number]; detScore: number; embedding: string }[] }>`; throws on a non-2xx response.
  - `CloudflareClient.facesPending(hashes: string[], model: string): Promise<Set<string>>` (batches of 500 like `checkHashes`) and `CloudflareClient.ingestFaces(contentHash: string, model: string, faces: { bbox: { x: number; y: number; w: number; h: number }; detScore: number; embedding: string }[]): Promise<boolean>` (false on 404).
  - `prepareFaceImage(filePath: string): Promise<Buffer>` (sharp, `.rotate()`, longest side 1280, JPEG q90) and `scanFaces(filePath: string, contentHash: string, deps: { sidecar: FaceSidecarClient; cloudflareClient: CloudflareClient }): Promise<number>` returning the face count; bbox is converted from pixels to 0..1 using the sidecar's `width` and `height`, clamped to the image.
  - `backfillFaces(folder: string, deps: { cloudflareClient; sidecar; onProgress? }): Promise<{ total: number; scanned: number; faces: number; skipped: number; notIndexed: number; failed: number }>`: scans a folder like `backfillExif`, hashes files, asks `facesPending` in batches of 100, scans only pending ones; a re-run skips everything already scanned.
  - `processFile`: when `deps.faceSidecar` is provided, call `scanFaces` after `ingestPhoto`; a failure is logged through `onProgress`-style console output and does not fail the photo (the backfill will pick it up).
  - CLI: `backfill-faces <folder>`, listed in the usage text; exit code 1 when any file failed.

- [ ] **Step 1: Failing tests:** `sidecarClient posts the jpeg and returns faces`, `sidecarClient throws on a 500`, `scanFaces converts pixel boxes to normalised boxes and posts them`, `scanFaces posts an empty list for a photo with no faces` (Review Focus 1), `backfillFaces skips already scanned hashes`, `backfillFaces counts not-indexed and failed separately`, `cloudflareClient.facesPending batches 500` , `ingestFaces returns false on 404`, `processFile does not fail when the sidecar is down`, `processFile skips scanning when no sidecar is configured`, `config accepts and omits FACE_SIDECAR_URL`, `cli backfill-faces exits 1 on a failure`.
- [ ] **Step 2: Run** `cd agent && npx vitest run`. Expect FAIL.
- [ ] **Step 3: Implement** the files above, injecting `fetchFn` and the sidecar so tests use fakes; wire the sidecar into the existing command paths that build `processFile` deps (`index-local`, `index-batch`, `index-drive`) when `FACE_SIDECAR_URL` is set.
- [ ] **Step 4: Run** `cd agent && npm test && npm run typecheck`. Expect PASS.
- [ ] **Step 5: Docs:** add `FACE_SIDECAR_URL` to `agent/.env.example` and the config table in `docs/architecture.md`; add a "Faces" section to `README.md` (start the sidecar, then `backfill-faces`). Commit `feat(agent): scan faces and backfill-faces command`.

---

### Task 10: Frontend types and API client

**Files:**
- Modify: `src/types/api.ts`, `src/services/api/WorkerApiClient.ts`
- Test: `src/services/api/__tests__/WorkerApiClient.test.ts`

**Interfaces:**
- Produces types: `SerializedFace` (as Task 3), `PersonSummary { id: string; name: string; faceCount: number; photoCount: number; cover: SerializedFace | null }`, `FaceGroup { faces: SerializedFace[] }`, `MatchResponse { auto: SerializedFace[]; suggestions: SerializedFace[]; scanned: number; nextCursor: string | null }`.
- Produces client methods: `getPeople(): Promise<PersonSummary[]>`, `getFaceGroups(cursor?: string): Promise<{ groups: FaceGroup[]; scanned: number; nextCursor: string | null }>`, `getPhotoFaces(photoId: string): Promise<SerializedFace[]>`, `createPerson(name: string, faceIds?: string[]): Promise<{ id: string; name: string }>`, `renamePerson(id: string, name: string): Promise<void>`, `deletePerson(id: string): Promise<void>`, `assignFaces(personId: string, faceIds: string[]): Promise<void>`, `assignFace(faceId: string, personId: string): Promise<SerializedFace>`, `rejectFace(faceId: string, personId: string): Promise<SerializedFace>`, `unassignFace(faceId: string): Promise<SerializedFace>`, `matchPerson(personId: string, opts?: { apply?: boolean; cursor?: string }): Promise<MatchResponse>`, and `matchPersonAll(personId: string, onPage?: (scanned: number, matched: number) => void): Promise<{ matched: number }>` which calls `matchPerson(personId, { apply: true, cursor })` page by page until `nextCursor` is null (stops after 50 pages as a safety valve); `SearchParams` gains `people?: string[]` sent as a comma-joined `people` param. Writes follow the existing `updatePhoto` pattern (JSON body, error message with status).

- [ ] **Step 1: Failing tests** (existing client test style, fake `fetchFn`): one per method for method, URL and body, `matchPersonAll follows the cursor until it is null and sums the matches`, `matchPersonAll stops after 50 pages`, plus `search sends people as a comma list` and `a failed write throws with the status`.
- [ ] **Step 2: Run** `npx vitest run src/services/api`. Expect FAIL.
- [ ] **Step 3: Implement** the types and methods; factor a private `sendJson(method, path, body)` for the writes instead of repeating `updatePhoto`'s body.
- [ ] **Step 4: Run** `npm test && npm run lint`. Expect PASS.
- [ ] **Step 5: Commit** `feat(frontend): people API client and types`.

---

### Task 11: Faces on the photo page

**Files:**
- Create: `src/components/FaceTile.tsx`, `src/components/PhotoFaces.tsx`
- Modify: `src/components/PhotoDetail.tsx`
- Test: `src/components/__tests__/PhotoFaces.test.tsx`

**Interfaces:**
- Produces: `FaceTile` props `{ face: SerializedFace; size?: number }`, renders the face by CSS-cropping the 400 px thumbnail from its normalised bbox (background size and position computed from `bbox`), with the person name as a caption when assigned. `PhotoFaces` props `{ photoId: string; thumbnailUrl: string }`: shows the thumbnail with a numbered box per face, then one row per face with its tile, status (`Auto-matched`, `Confirmed`, `Unnamed`) and actions: name it (existing person from a select, or "New person" with a name input), "Not {name}" for an auto or confirmed match (rejects), and "Remove name" (unassign). Hidden when the photo has no faces. Every action that names a face (new or existing person) then calls `matchPersonAll(personId)` so the person's existing unnamed faces attach automatically, shows a notification "Matched N more photos", and invalidates `['photo-faces', photoId]`, `['people']` and the search queries.
- Consumes: client methods from Task 10.

- [ ] **Step 1: Failing tests** (`renderWithProviders`, mocked `workerApiClient`): `renders nothing when the photo has no faces`, `shows a numbered box and a row per face`, `naming an unnamed face as a new person calls createPerson with the face id`, `choosing an existing person calls assignFace`, `Not X calls rejectFace and the row refreshes`, `Remove name calls unassignFace`, `an auto-matched face is labelled as such`, `naming a face triggers matchPersonAll for that person`.
- [ ] **Step 2: Run** `npx vitest run src/components/__tests__/PhotoFaces.test.tsx`. Expect FAIL.
- [ ] **Step 3: Implement**; mount `PhotoFaces` in `PhotoDetail` below the metadata section. Use Mantine `Select`, `TextInput`, `Button`; no hover-only controls (mobile).
- [ ] **Step 4: Run** `npm test && npm run lint && npm run build`. Expect PASS.
- [ ] **Step 5: Commit** `feat(frontend): name and correct faces on the photo page`.

---

### Task 12: People page and person page

**Files:**
- Create: `src/components/People.tsx`, `src/components/PersonPage.tsx`
- Modify: `src/App.tsx` (routes `/people`, `/people/:id`), `src/components/Layout.tsx` (nav item "People")
- Test: `src/components/__tests__/People.test.tsx`, `src/components/__tests__/PersonPage.test.tsx`

**Interfaces:**
- Consumes: Task 10 client methods, `FaceTile`.
- Produces:
  - `People`: a grid of named people (cover tile, name, counts, link to `/people/:id`), then "Unnamed groups": each group shows up to 8 face tiles and a "Name this group" action (new name, or add to an existing person) that calls `createPerson(name, faceIds)` or `assignFaces` and then `matchPersonAll(personId)`, with a progress line while it runs. A "Load more" button follows `nextCursor`. Empty state when no faces exist yet.
  - `PersonPage`: header with rename and delete (with confirm), their photos as a grid from `search({ people: [id] })`, a "Review suggestions" button running `matchPerson(id)` without `apply` and showing the suggestion band as tiles, each with Yes (`assignFace`) and Not them (`rejectFace`), plus "Check more" when `nextCursor` is set; and a "Re-run matching" button calling `matchPersonAll(id)` (matching is otherwise automatic). Auto-matched faces appear in the person's photos with an "Auto" badge and a "Not {name}" action.

- [ ] **Step 1: Failing tests:** `People lists named people and unnamed groups`, `naming a group calls createPerson with all its face ids`, `adding a group to an existing person calls assignFaces`, `Load more follows the cursor`, `PersonPage shows photos for the person`, `Review suggestions shows only the suggestion band`, `Yes on a suggestion calls assignFace`, `Not them calls rejectFace and removes the tile`, `Re-run matching calls matchPersonAll`, `naming a group then runs matchPersonAll`, `deleting a person asks for confirmation first`.
- [ ] **Step 2: Run** `npx vitest run src/components/__tests__/People.test.tsx src/components/__tests__/PersonPage.test.tsx`. Expect FAIL.
- [ ] **Step 3: Implement** both components and the routes and nav item (update `Layout.test.tsx` expectations if it asserts the nav list).
- [ ] **Step 4: Run** `npm test && npm run lint && npm run build`. Expect PASS.
- [ ] **Step 5: Commit** `feat(frontend): People page and person page`.

---

### Task 13: People filter on the search page

**Files:**
- Modify: `src/components/Search.tsx`, `src/hooks/useListParams.ts` (only if the filter belongs in URL state, which it should, like `album`)
- Test: `src/components/__tests__/Search.test.tsx`, `src/hooks/__tests__/useListParams.test.ts`

**Interfaces:**
- Produces: a "People" multi-select (max 5) on the search page, stored in the URL as `people=<id>,<id>`, passed to `searchPage({ people })`; photos shown only when all selected people are present.

- [ ] **Step 1: Failing tests:** `selecting two people puts both ids in the URL and the request`, `people filter is restored from the URL`, `clearing the filter removes the param`.
- [ ] **Step 2: Run** the two test files. Expect FAIL.
- [ ] **Step 3: Implement** with Mantine `MultiSelect` fed by `getPeople()`.
- [ ] **Step 4: Run** `npm test && npm run lint && npm run build`. Expect PASS.
- [ ] **Step 5: Commit** `feat(frontend): filter search by people`.

---

### Task 14: Docs, graph and real-library check

**Files:**
- Modify: `README.md`, `AGENTS.md`, `docs/architecture.md`, `docs/development.md`

- [ ] **Step 1: Docs sweep.** README: People feature, sidecar setup, `backfill-faces`, the new browser writes. AGENTS.md: layout (sidecar), the "owner decisions" rule extended to `person_id` and `assign_status`, the proxy writes list. `docs/architecture.md`: faces data flow, tables, config (`FACE_SIDECAR_URL`), the matching module and thresholds. `docs/development.md`: sidecar commands. Check there are no em dashes: `grep -rn $'\xe2\x80\x94' README.md AGENTS.md docs/architecture.md docs/development.md` returns nothing new.
- [ ] **Step 2: Rebuild the graph:** `graphify update .`.
- [ ] **Step 3: Run every suite:** `cd worker && npm test && npm run typecheck`, `cd agent && npm test && npm run typecheck`, root `npm test && npm run lint && npm run build`. All pass.
- [ ] **Step 4: Manual check on real photos (owner present):** start the sidecar, run `backfill-faces` on `Bandipur (12,13,14-Sep-2026)/Processed` and `Aganvee 3 Photoshoot/Processed`; open `/people`, name the adult group, check that naming attached the other photos by itself, name the child, and confirm the age case yields suggestions in the 0.4 to 0.5 band under "Review suggestions"; re-run `backfill-faces` on a fresh copy of one photo of a named person and confirm it arrives already attached; correct one wrong match with "Not X" and re-run to confirm it stays gone. Note any threshold change as a follow-up, not in this PR.
- [ ] **Step 5: Commit** `docs: faces and people`, then open the PR (migration `0009` auto-applies on merge; additive, no bookmark needed).
