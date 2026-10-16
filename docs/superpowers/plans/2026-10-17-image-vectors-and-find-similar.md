# Image Vectors and Find Similar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent embeds every photo with SigLIP 2 and pushes the vector to D1; a "Find similar" button on the photo page shows the 4 closest photos, scored by the Worker on a bounded candidate set.

**Architecture:** The Python sidecar in `agent/sidecar` gains `POST /embed` (open_clip). A new `/ingest/embedding` route stores one vector per photo in a new `photo_embeddings` table. `GET /photos/:id/similar` builds FTS5 candidates from the photo's own subjects, tags, colours and season, fetches at most `SIMILAR_CANDIDATE_CAP` vectors with index lookups, and ranks them by dot product in the Worker. `backfill-vectors` follows the index exactly like `backfill-faces`.

**Tech Stack:** Hono Worker + D1 (FTS5, `json_each`), Vitest (`@cloudflare/vitest-pool-workers`), Node/TS agent with sharp, Python `open_clip_torch`, React 19 + Mantine + TanStack Query.

**Spec:** `docs/superpowers/specs/2026-10-16-image-vectors-and-people-design.md` (phase B sections). Where this plan differs from the spec, "Changes to the spec" below wins.

## Changes to the spec

1. **Migration is `0015_photo_embeddings.sql`** (0012 to 0014 are taken).
2. **Vectors live in a new table, not on `photos`.** The spec put `image_embedding` on `photos`. Search, daily pick and the album routes run `SELECT photos.*`, so a 3 KB value on every photo row would ride along on every list and search. A side table keyed by the photo's rowid costs nothing for those routes and lets the similar route fetch vectors by primary key.
3. **Candidates are unsorted `LIMIT cap`, not bm25-ordered.** Measured on prod (2,580 photos, 2026-10-17, `meta.rows_read`):

   | Query | rows_read |
   |---|---|
   | FTS `ORDER BY bm25 LIMIT 1000`, 1,741 matches | 3,482 (2 per match; LIMIT does not bound it) |
   | same, joined to `photos` for the id | 5,223 |
   | FTS `ORDER BY bm25 LIMIT 200` | 2,730 |
   | FTS `LIMIT 1000`, no ORDER BY | 999 |
   | `search_primary:` AND of two terms, LIMIT 1000 | 132 (one per match) |
   | no-ORDER FTS rowids, then join `photos` by rowid | 1,999 (2 per candidate) |

   bm25 ordering reads every match, so the cost grows with the library and the cap does not bound it. The final order is by vector similarity anyway, so bm25 only decides which photos survive truncation. Dropping it makes the FTS cost at most `cap` reads. The price is that truncation follows rowid order when a tier matches more than the cap; the response reports `capped` so the UI says so. Candidates are never ordered or filtered by date, album or location (rowid is only used as a stable key).
4. **Tiered candidates replace one OR query.** Tiers run strictest first and stop at the first with at least `MIN_CANDIDATES` rows (20), so a rare subject is cheap and a common one hits the cap in one query. Each FTS query matches the `search_primary` column only.
5. **Vector bytes through D1 are a CPU risk the spec did not name.** D1 hands BLOB columns to a Worker as number arrays, so 1,000 x 768 means roughly 770k numbers to build per click, against a ~10 ms free CPU budget. Task 1 measures this before any schema is committed. All encoding lives in one module so the answer changes one file.

## Global Constraints

- Free tier only: no Vectorize, Workers AI, Queues, or paid feature.
- `GET /photos/:id/similar` takes no parameters and returns the **4** closest photos (`SIMILAR_RESULTS`).
- `SIMILAR_CANDIDATE_CAP` is one constant, default **1000**, may drop to **200**. It is exported from `worker/src/similar/constants.ts` only.
- Scoring compares only vectors with the same `model`. Model name stored: `siglip2-b16-256` (open_clip `ViT-B-16-SigLIP2-256`, 768-d, L2-normalised).
- Candidates come from the photo's own subjects, tags, colours and season, using the owner's `user_*` values when set (`effectiveText`). Nothing from date, location or album.
- **D1 read budget** (`docs/development.md`): `json_each` for id lists, no window functions, no `UPDATE ... FROM`, no `id IN (SELECT ... json_each)`. Per-click acceptance: **<= 2,500 `rows_read` typical and <= 4,000 worst case at cap 1000**, measured on prod with `wrangler d1 execute pixdex --remote --json`.
- `/ingest/embedding*` is never in `ALLOWED_PATHS`. The read route `photos/:id/similar` is. `INGEST_TOKEN`, `READ_TOKEN`, `ORIGINALS_TOKEN` never reach the browser. Vectors never reach the browser.
- Owner data is untouched: this feature writes no `user_*` column and no `faces` column.
- Migrations are additive and mirrored in `worker/migrations/index.ts`.
- No em dashes in docs or code comments. Update `README.md`, `AGENTS.md` and `docs/` in the same commit as the change they describe.
- The pre-commit hook runs the touched suites; do not bypass it.

## Review Focus

1. A photo with no embedding yet (or embedded with another model) requests `/similar`: expect a clean 200 `{ results: [], reason: "not_embedded" }`, not a 500, and the button shows "Not analysed yet".
2. A photo with no subjects, tags, colours or season: expect the recent-embedded fallback, still capped, still excluding itself.
3. A subject containing FTS5 syntax characters (`"`, `-`, `:`, `(`, `*`) or a multi-word label ("snow leopard"): expect no MATCH syntax error and a sensible match.
4. Photos with fewer than 4 scored candidates (small or half-backfilled library): expect fewer results, never an error, and `scored_count` honest.
5. Re-ingesting a photo's embedding or a model swap mid-backfill: expect an overwrite of that photo's row, no duplicate, and old-model vectors ignored by scoring.

---

## File Structure

| File | Responsibility |
|---|---|
| `worker/migrations/0015_photo_embeddings.sql` (+ `index.ts` mirror) | `photo_embeddings` table, `photos.embedded_model` |
| `worker/src/similar/constants.ts` | `SIMILAR_CANDIDATE_CAP`, `SIMILAR_RESULTS`, `MIN_CANDIDATES`, `EMBEDDING_MODEL_DIM` |
| `worker/src/similar/vector.ts` | encode/decode of stored vectors, `dot` (the only place that knows the storage encoding) |
| `worker/src/similar/candidates.ts` | FTS tier builder and bounded candidate fetch |
| `worker/src/similar/score.ts` | pure top-k scorer |
| `worker/src/routes/ingest-embedding.ts` | `unembedded` list, `ingest/embedding` write |
| `worker/src/routes/similar.ts` | `GET /photos/:id/similar` |
| `agent/sidecar/server.py` | add `POST /embed`, `/health` reports both models |
| `agent/src/embeddings/*.ts`, `agent/src/backfillVectors.ts` | sidecar client, per-photo `embedPhoto`, index-driven backfill |
| `src/components/SimilarPhotos.tsx` | button, results grid, capped note |

---

### Task 1: CPU and encoding spike (throwaway, nothing merged except the findings)

**Files:**
- Create (not committed): a scratch D1 `pixdex-scratch`, a scratch Worker under the scratchpad directory
- Modify: `docs/development.md` ("D1 read budget" section gets a "Find similar" bullet with the measured numbers)

**Interfaces:**
- Produces: the chosen stored encoding (one of `blob-f32`, `text-b64-f32`, `text-b64-int8`) and the confirmed cap, both recorded in `docs/development.md` and used by Task 3.

- [ ] **Step 1: Create `pixdex-scratch` with a table of 1,000 random L2-normalised 768-d vectors stored three ways** (BLOB float32, base64 TEXT float32, base64 TEXT int8) via `wrangler d1 execute pixdex-scratch --remote --file`.
- [ ] **Step 2: Deploy a scratch Worker with three GET routes**, one per encoding, each doing `SELECT ... LIMIT ?` (cap from the query string), decoding, and computing 1,000 dot products against the first vector.
- [ ] **Step 3: Measure Worker CPU** with `npx wrangler tail --format json` while hitting each route 20 times at caps 200 and 1000; take p50 and p95 of `cpuTime`.
- [ ] **Step 4: Decide.** Pick the first encoding whose p95 CPU at cap 1000 is <= 8 ms (order: `blob-f32`, `text-b64-f32`, `text-b64-int8`). If none fits, set the cap to 200 and re-check. If 200 still fails, stop and report: scoring then has to move to the agent behind the tunnel (spec fallback), which is a different plan.
- [ ] **Step 5: Delete `pixdex-scratch` and the scratch Worker. Record the table of numbers and the decision in `docs/development.md`. Commit.**

```bash
git add docs/development.md
git commit -m "docs: record find-similar CPU and encoding measurements"
```

---

### Task 2: Migration 0015 and the vector codec

**Files:**
- Create: `worker/migrations/0015_photo_embeddings.sql`, `worker/src/similar/constants.ts`, `worker/src/similar/vector.ts`
- Modify: `worker/migrations/index.ts` (append the mirrored statements to `BASE_MIGRATION_STATEMENTS`)
- Test: `worker/test/schema.test.ts`, `worker/test/similar-vector.test.ts`

**Interfaces:**
- Produces:
  - Table `photo_embeddings(photo_rowid INTEGER PRIMARY KEY, photo_id TEXT NOT NULL UNIQUE, model TEXT NOT NULL, embedding BLOB NOT NULL, created_at TEXT NOT NULL)`.
  - Column `photos.embedded_model TEXT` (set by the ingest route, drives the backfill like `faces_scanned_model`).
  - `constants.ts`: `SIMILAR_CANDIDATE_CAP = 1000`, `SIMILAR_RESULTS = 4`, `MIN_CANDIDATES = 20`, `EMBEDDING_DIM = 768`, `EMBEDDING_MODEL = 'siglip2-b16-256'`.
  - `vector.ts`: `encodeVector(v: Float32Array): string | Uint8Array` (storage form per Task 1), `decodeVector(raw: unknown): Float32Array` (accepts what D1 returns for that form, throws `Error('invalid embedding')` on wrong length), `vectorFromBase64(b64: string): Float32Array` (agent wire format: base64 of 768 little-endian float32, L2-normalised on the way in, throws on zero or non-finite), `dot(a: Float32Array, b: Float32Array): number`.

- [ ] **Step 1: Write failing tests.** `schema.test.ts`: table and `embedded_model` column exist, and inserting two rows with the same `photo_id` fails (UNIQUE). `similar-vector.test.ts`: `vectorFromBase64` of a 768-float vector returns norm 1 (to 1e-6); a 767-float vector, `not base64!`, and an all-zero vector each throw `invalid embedding`; `decodeVector(encodeVector(v))` equals `v`; `dot` of a unit vector with itself is 1 and with an orthogonal one is 0.
- [ ] **Step 2: Run** `cd worker && npx vitest run test/schema.test.ts test/similar-vector.test.ts`. Expected: FAIL (missing table, missing module).
- [ ] **Step 3: Write the migration** (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE photos ADD COLUMN embedded_model TEXT`), mirror it in `index.ts` with a "Mirrors 0015_photo_embeddings.sql" comment like its neighbours, and implement `constants.ts` and `vector.ts` with the encoding Task 1 chose.
- [ ] **Step 4: Run** `cd worker && npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(worker): photo_embeddings table and vector codec`.

---

### Task 3: Ingest routes (`unembedded`, `embedding`)

**Files:**
- Create: `worker/src/routes/ingest-embedding.ts`
- Modify: `worker/src/index.ts` (register under the existing `app.use('/ingest/*', requireIngestToken)`)
- Test: `worker/test/ingest-embedding.test.ts`

**Interfaces:**
- Consumes: `vectorFromBase64`, `encodeVector`, `EMBEDDING_MODEL` (Task 2).
- Produces:
  - `POST /ingest/embedding/unembedded` body `{ model, cursor?, limit? (1..500, default 200), pathPrefix? }` returns `{ items: {contentHash, path}[], nextCursor: number | null }`. Same query shape as `unscannedFacesRoute` with `embedded_model` in place of `faces_scanned_model`, `source = 'local' AND path IS NOT NULL`, paged by `rowid`, LIKE-escaped prefix.
  - `POST /ingest/embedding` body `{ contentHash, model, embedding }` returns `{ stored: true }`; 404 `Unknown content hash`; 400 `Invalid embedding`. Upserts by `photo_rowid` (`INSERT ... ON CONFLICT(photo_rowid) DO UPDATE`) and sets `photos.embedded_model` in one `DB.batch`. Unknown body keys are dropped (zod object), and the route writes no other column.

- [ ] **Step 1: Write failing tests**: stores a vector and sets `embedded_model`; a second post with the same hash overwrites, leaving exactly one row; unknown hash gives 404; a 767-float embedding gives 400; wrong `INGEST_TOKEN` gives 401; `unembedded` omits photos already embedded with that model and includes ones embedded with a different model; `unembedded` pages by cursor and honours `pathPrefix` containing `%` literally; a body containing `person_id` or `user_rating` changes nothing on `photos`.
- [ ] **Step 2: Run** `cd worker && npx vitest run test/ingest-embedding.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `unembeddedRoute` and `ingestEmbeddingRoute` in `ingest-embedding.ts`, copying the structure and `readJson` handling of `ingest-faces.ts`.
- [ ] **Step 4: Run** `cd worker && npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(worker): ingest routes for image embeddings`.

---

### Task 4: Candidate builder and scorer

**Files:**
- Create: `worker/src/similar/candidates.ts`, `worker/src/similar/score.ts`
- Test: `worker/test/similar-candidates.test.ts`, `worker/test/similar-score.test.ts`

**Interfaces:**
- Consumes: `effectiveText` and `PhotoRow` from `worker/src/db/photos.ts`, `expandQuery` and `quoteFts5Term` from `worker/src/search/synonyms.ts`, `decodeVector`/`dot` (Task 2), constants.
- Produces:
  - `candidateTiers(row: PhotoRow): string[]`: MATCH expressions, strictest first, each prefixed `search_primary:`. Tiers: (1) AND of all subject groups plus the first 3 tags, (2) AND of subject groups, (3) OR of subject groups, (4) OR of subjects, tags, colours and season. Terms go through `expandQuery` so synonyms and word families apply, and every literal through `quoteFts5Term`. Empty and duplicate tiers are dropped. A row with no usable terms returns `[]`.
  - `fetchCandidateRowids(db: D1Database, row: PhotoRow): Promise<{ rowids: number[]; capped: boolean; tier: number | 'recent' }>`: runs tiers in order with `SELECT rowid FROM photos_fts WHERE photos_fts MATCH ? AND rowid != ? LIMIT ?` (cap), stops at the first tier with `>= MIN_CANDIDATES`, otherwise keeps the largest tier seen. `capped` is true when a tier returned exactly the cap. With `[]` tiers or nothing found it falls back to `SELECT photo_rowid FROM photo_embeddings WHERE model = ? AND photo_rowid != ? ORDER BY photo_rowid DESC LIMIT ?` and returns `tier: 'recent'`. No `ORDER BY bm25`, no window functions.
  - `loadVectors(db: D1Database, rowids: number[], model: string): Promise<{ rowid: number; vector: Float32Array }[]>`: `SELECT e.photo_rowid AS rowid, e.embedding FROM json_each(?) j CROSS JOIN photo_embeddings e ON e.photo_rowid = j.value WHERE e.model = ?`.
  - `topK(query: Float32Array, candidates: {rowid: number; vector: Float32Array}[], k: number): {rowid: number; score: number}[]`: descending by dot product, ties broken by lower rowid, single pass keeping a k-sized buffer (no full sort).

- [ ] **Step 1: Write failing tests.** Scorer: known vectors give the expected order and scores; equal scores order by rowid; fewer than k candidates returns all; empty returns `[]`. Tiers: subjects `["tiger"]` yields a tier containing `tiger` and its synonym; a subject `snow "leopard" -x:(` produces expressions that the real FTS5 table accepts (run each against the test DB, expecting no error); user overrides win over model values; a row with empty arrays and no season returns `[]`. Fetch: a rare subject stops at tier 1 with `capped: false`; a subject shared by more photos than the cap (seed 1,100 rows) returns exactly the cap with `capped: true`; the query photo's own rowid is never returned; a photo with no text falls back to `recent`, newest rowid first.
- [ ] **Step 2: Run** `cd worker && npx vitest run test/similar-candidates.test.ts test/similar-score.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both modules to the signatures above.
- [ ] **Step 4: Run** `cd worker && npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(worker): bounded candidate selection and top-k scoring`.

---

### Task 5: `GET /photos/:id/similar`, proxy entry, and the prod read-budget gate

**Files:**
- Create: `worker/src/routes/similar.ts`, `src/services/__tests__/proxy.test.ts`
- Modify: `worker/src/index.ts` (`app.get('/photos/:id/similar', similarRoute)` under the existing `/photos/*` read-token middleware, registered before `/photos/:id`), `functions/api/[[path]].ts` (add `/^photos\/[^/]+\/similar$/` to `ALLOWED_PATHS`)
- Test: `worker/test/similar.test.ts`

**Interfaces:**
- Consumes: Task 4 exports, `serializePhoto`.
- Produces: response `{ results: SerializedPhoto[] /* <= 4, best first */, scoredCount: number, candidateCount: number, capped: boolean, cap: number, reason?: 'not_embedded' }`. Query photo is excluded. 404 for an unknown photo id. A photo with no embedding for `EMBEDDING_MODEL` returns 200 with `results: []` and `reason: 'not_embedded'` and does no candidate query. Final photos are fetched with `photos.rowid IN` via `json_each(?) j CROSS JOIN photos ON photos.rowid = j.value`, then reordered to score order.

- [ ] **Step 1: Write failing tests** (seed photos with orthogonal and near vectors): the closest photos come back in score order and the query photo is absent; `capped` and `candidateCount` reflect a cap overflow; a photo embedded with a different model counts as `not_embedded`; a candidate embedded with another model is not scored; fewer than 4 candidates returns fewer; no token gives 401; `photos/x/similar` is not captured by `/photos/:id`. Proxy test: `GET /api/photos/abc/similar` is forwarded; `/api/ingest/embedding` and `/api/ingest/embedding/unembedded` return 404; `/api/photos/abc/similar/extra` returns 404.
- [ ] **Step 2: Run** worker and root suites for those files. Expected: FAIL.
- [ ] **Step 3: Implement** `similarRoute` (get row, get its embedding by `photo_rowid`, `fetchCandidateRowids`, `loadVectors`, `topK`, fetch and serialize winners) and add the proxy entry.
- [ ] **Step 4: Run** `cd worker && npm test && npm run typecheck`, then `npm test && npm run lint` at the root. Expected: PASS.
- [ ] **Step 5: Commit** `feat(worker): GET /photos/:id/similar`. Do not merge yet.
- [ ] **Step 6: Prod read-budget gate** (after Tasks 6 to 8 have filled `photo_embeddings` on prod; the route ships last, see Rollout). For 10 photos spanning rare, common and no-text cases, run the route's exact SQL through `wrangler d1 execute pixdex --remote --json` and sum `meta.rows_read` per click. Pass: typical <= 2,500, worst <= 4,000, and `wrangler tail` CPU p95 <= 8 ms. Otherwise lower `SIMILAR_CANDIDATE_CAP` toward 200 and re-measure. Record the table in `docs/development.md` under "D1 read budget".

---

### Task 6: Sidecar `/embed`

**Files:**
- Modify: `agent/sidecar/server.py`, `agent/sidecar/requirements.txt` (pin `open_clip_torch`, `torch`, `Pillow` at exact versions that install on Python 3.11 or 3.12 on Apple silicon), `agent/sidecar/README.md`
- Test: manual (the sidecar has no automated tests, as in phase A); the contract is pinned by the agent client test in Task 7.

**Interfaces:**
- Produces: `POST /embed` (JPEG body, same size and error handling as `/faces`) returns `{"model": "siglip2-b16-256", "embedding": "<base64 of 768 little-endian float32, L2-normalised>"}`. `GET /health` returns `{"ok": true, "model": "buffalo_l", "embedModel": "siglip2-b16-256"}`; the existing `model` key is unchanged so phase A clients keep working. Model loads once at startup on `mps` with CPU fallback, behind the same inference lock. The caller sends an already EXIF-rotated image, as for `/faces`.

- [ ] **Step 1: Add the `/embed` handler** using `open_clip.create_model_and_transforms('ViT-B-16-SigLIP2-256', pretrained='webli')`, `encode_image`, then L2 normalise.
- [ ] **Step 2: Verify by hand.** Start the sidecar, `curl -s -X POST --data-binary @some.jpg -H 'Content-Type: image/jpeg' http://127.0.0.1:8799/embed | python3 -c "import sys,json,base64;d=json.load(sys.stdin);print(d['model'],len(base64.b64decode(d['embedding'])))"`. Expected: `siglip2-b16-256 3072`. A non-image body returns 400.
- [ ] **Step 3: Check the weights' licence on the official model card** and write it in the README next to the InsightFace non-commercial note (the spec says to re-verify before building).
- [ ] **Step 4: Update `agent/sidecar/README.md`** (endpoints, the extra install size, first-run download location).
- [ ] **Step 5: Commit** `feat(sidecar): POST /embed with SigLIP 2`.

---

### Task 7: Agent client, `embedPhoto`, indexing hook, `backfill-vectors`

**Files:**
- Create: `agent/src/embeddings/embedPhoto.ts`, `agent/src/backfillVectors.ts`
- Modify: `agent/src/faces/sidecarClient.ts` (add `embed(jpeg: Buffer): Promise<{ model: string; embedding: string }>` and `embedModel(): Promise<string>` reading `/health.embedModel`; reuse `FaceSidecarClient`, no second client class), `agent/src/cloudflareClient.ts` (`embeddingsUnembedded(model, opts)` and `ingestEmbedding(contentHash, model, embedding): Promise<boolean>` returning false on 404), `agent/src/processFile.ts` (after `scanFaces`, call `embedPhoto` inside its own try/catch that only warns), `agent/src/cli.ts` (`backfill-vectors [folder]`)
- Test: `agent/test/embedPhoto.test.ts`, `agent/test/backfillVectors.test.ts`, extend `agent/test/sidecarClient.test.ts`, `agent/test/cloudflareClient.test.ts`, `agent/test/processFile.test.ts`, `agent/test/cli.test.ts`

**Interfaces:**
- Consumes: `prepareFaceImage` from `agent/src/faces/scanFaces.ts` (the same upright 1280 px JPEG, so the file is decoded once per step as for faces), Task 3 routes.
- Produces:
  - `embedPhoto(filePath: string, contentHash: string, deps: { sidecar: FaceSidecarClient; cloudflareClient: CloudflareClient }): Promise<void>`, throwing `PhotoNotIndexedError` (imported from `scanFaces.ts`) on a 404.
  - `backfillVectors(deps: { cloudflareClient; sidecar; pathPrefix?; onProgress? }): Promise<{ total: number; embedded: number; missing: number; notIndexed: number; failed: number }>`, same loop, counters and cursor paging as `backfillFaces`, using `sidecar.embedModel()`.
  - CLI line: `Done. Unembedded: N, Embedded: N, File missing: N, Not indexed: N, Failed: N`, exit 1 when `failed > 0`, error when `FACE_SIDECAR_URL` is unset.

- [ ] **Step 1: Write failing tests** with a fake sidecar and fake client: `embedPhoto` posts the sidecar's embedding string untouched with the model it reported; a 404 from the client raises `PhotoNotIndexedError`; `backfillVectors` skips a missing file and counts it, counts `notIndexed`, continues after a failed photo, and is resumable (a second run only requests what the Worker still lists); `processFile` still succeeds and warns when `embed` throws; `cloudflareClient.ingestEmbedding` sends `INGEST_TOKEN` and only `contentHash`, `model`, `embedding`.
- [ ] **Step 2: Run** `cd agent && npx vitest run test/embedPhoto.test.ts test/backfillVectors.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** to the signatures above, following `backfillFaces.ts` line for line.
- [ ] **Step 4: Run** `cd agent && npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(agent): embed photos during indexing and backfill-vectors`.

---

### Task 8: Frontend "Find similar"

**Files:**
- Create: `src/components/SimilarPhotos.tsx`
- Modify: `src/services/api/WorkerApiClient.ts` (`getSimilarPhotos(photoId: string): Promise<SimilarResponse>`), `src/types/api.ts` (`SimilarResponse`), `src/components/PhotoDetail.tsx` (render `<SimilarPhotos photoId={photo.id} />` after `PhotoFaces`)
- Test: `src/components/__tests__/SimilarPhotos.test.tsx`, `src/services/api/__tests__/WorkerApiClient.test.ts`

**Interfaces:**
- Consumes: Task 5 response shape, `PhotoGrid`/`PhotoCard`.
- Produces: `SimilarPhotos({ photoId })`: a "Find similar" button that fires the query on click only (`enabled` false until clicked, `staleTime` 2 minutes like other lists, keyed by photo id). No filter controls. Renders the results grid; when `capped`, the note "Compared with the {cap} closest matches by subject and tags"; when `reason === 'not_embedded'`, "Not analysed yet"; when the grid is empty otherwise, "No similar photos found". Buttons and notes work at phone width with no hover-only actions.

- [ ] **Step 1: Write failing tests**: nothing is requested until the button is clicked; results render in the order returned; the capped note shows the cap number; `not_embedded` shows its message; an empty result shows the empty message; an error shows a retry; the client method calls `/photos/<id>/similar` with encoded id.
- [ ] **Step 2: Run** `npx vitest run src/components/__tests__/SimilarPhotos.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the component and client method.
- [ ] **Step 4: Run** `npm test && npm run lint && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: find similar photos button`.

---

### Task 9: Docs, graph, and rollout

**Files:**
- Modify: `README.md` (setup: sidecar `/embed`, `backfill-vectors`, Find similar behaviour), `AGENTS.md` (layout line for `worker/src/similar/`, the new commands, the proxy read-route list, a Rules bullet that the similar route must stay within the read-budget gate), `docs/architecture.md` (new "Image vectors and find similar" section: data flow, table, tiers, caps, config), `docs/development.md` (command list, D1 read budget numbers from Tasks 1 and 5), `agent/.env.example` only if a new variable was added (none planned)

- [ ] **Step 1: Update the docs above.** No em dashes. Mention that vectors never leave the Worker and that `/ingest/embedding*` is not proxied.
- [ ] **Step 2: Run** `graphify update .` and all four suites (root, worker, agent typecheck and tests). Expected: PASS.
- [ ] **Step 3: Commit** `docs: image vectors and find similar`.

**Rollout order (migrations auto-apply on merge to `main`, and there is no CI gate):**

1. PR 1 = Tasks 2, 3, 6, 7 and their docs. Safe to merge: no read route is added. Then run `backfill-vectors` against the live library and watch `wrangler d1 insights pixdex --timePeriod 1d --sort-type sum --sort-by reads --limit 12 --json` during it.
2. PR 2 = Tasks 4, 5, 8. Run the Task 5 Step 6 gate on prod data (the route can be exercised before the UI is merged by deploying PR 2 with the button last). Merge only if it passes.
3. Task 1's findings land with PR 1 (docs only).

## Self-Review

- **Spec coverage:** migration (Task 2, renumbered, table instead of columns, change 2), sidecar `open_clip` (6), embedding in the indexing pass (7), `backfill-vectors` (7), `/ingest/embedding` outside the allowlist (3, 5 proxy test), `GET /photos/:id/similar` with cap, `capped`, `candidate_count`, `scored_count`, owner overrides, synonyms, fallback and a single shared scorer module (4, 5), button and capped note (8), docs (9), CPU measurement before shipping (1, 5). Spec's bm25 ordering is the one deliberate deviation (change 3).
- **Naming:** the response uses camelCase (`scoredCount`, `candidateCount`) like every other route; the spec's snake_case names map one to one.
- **Open decision, deliberately empirical:** the stored encoding and final cap come from Task 1 and are fixed in Task 2 before any schema ships. Everything else is pinned.
