# Known Personalities, Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recognise a curated list of famous people on the owner's machine, store the matches on the Worker, and let the People filter on Search and Timeline find them by name or alias, AND-combined with the viewer's own people.

**Architecture:** A one-time agent script builds a local gallery of reference embeddings from Wikidata and Wikimedia Commons. The agent matches each face against it (at scan time, and in a backfill that reuses embeddings the Worker already stores) and sends only a known id and score per face. The Worker keeps a global `known_people` table and `faces.known_id`, and exposes a scoped list plus a `known` filter on `/search` and `/timeline`. The existing People dropdown gets a second, colour-coded group using a shared matcher.

**Tech Stack:** Cloudflare Worker (Hono, zod/mini, D1), Node/TS agent (sharp, InsightFace sidecar), React 19 + Mantine + TanStack Query, vitest everywhere.

**Spec:** `docs/superpowers/specs/2026-11-12-known-personalities-and-omnibox-design.md` (Phase 1 plus the shared matcher and colour rules from Phase 2). Phase 2 (the omnibox) is a separate plan.

## Global Constraints

- Worker free plan: 10 ms CPU per invocation; no embedding loops on the Worker for this feature.
- In `worker/`, `import * as z from 'zod/mini'`, never `'zod'`; `agent/` may use classic `zod`.
- DB changes only in a new numbered, additive migration (`0018_known_people.sql`), mirrored in `worker/migrations/index.ts` for tests. Never write `albums` or `counters` from route code.
- `faces.person_id` and `assign_status` are never set by known matching; a known match is independent of them and counts whether or not the face is also assigned.
- `/ingest/*` stays out of the Pages allowlist; only `GET people/known` is added. No tokens in the browser.
- Every Worker read stays scoped (`scopeFor`) and needs `X-Viewer-Email`.
- No photo, thumbnail or gallery embedding leaves the machine; the gallery file lives in `agent/.index-state/` (gitignored). External requests (Wikidata, Commons) use a generic User-Agent with no personal details.
- Known names are global reference data (not private); own people and known people are never merged or hidden, and are colour-coded (own: blue, known: violet) plus a "known" marker and group heading.
- Combined filter cap: 5 (`people` + `known` together). Matching: case and accent insensitive, every typed word must prefix a word of the name or an alias, no fuzzy matching, minimum 3 characters per span.
- No em dashes in any text written. Update `README.md`, `AGENTS.md` and `docs/` in the same PR; run `graphify update .` after code changes. Pre-commit hook runs touched suites; do not bypass.

## Review Focus

1. A face scanned with a different embedding model than the gallery: the agent skips known matching (and says so), the Worker never stores a mismatched match.
2. Re-scanning a photo replaces its unassigned and auto faces, so their known ids are lost unless the new payload carries them; confirmed faces keep theirs.
3. A viewer who can see none of a person's photos must not see that person in `GET /people/known`, nor get counts or results from `known=`.
4. `known=` with an unknown id, duplicates, or more than the combined cap must degrade (ignore or zero results), never 500 or widen results.
5. Names that are hard to match: "A. R. Rahman" vs "ar rahman", accented or non-Latin names, aliases that duplicate the name, and queries made only of punctuation.

## File Structure

Worker: `worker/migrations/0018_known_people.sql` (+ mirror in `worker/migrations/index.ts`), `worker/src/db/known.ts` (parse and SQL for the filter), `worker/src/routes/ingest-known.ts` (agent-only routes), `worker/src/routes/known.ts` (viewer list), edits to `ingest-faces.ts`, `search.ts`, `timeline.ts`, `index.ts`. Proxy: `functions/api/[[path]].ts`.

Agent: `agent/known/people.json` (405 verified people, at least 200 required) and `agent/known/README.md` (how to add more), `agent/src/known/{gallery,matcher,wikimedia,buildGallery,list}.ts`, `agent/src/backfillKnown.ts`, edits to `faces/scanFaces.ts`, `cloudflareClient.ts`, `cli.ts`, and the call sites that pass `sidecar` to `scanFaces`.

Frontend: `src/services/personMatch.ts` (shared matcher), `src/components/PeopleFilter.tsx` (the combined dropdown), edits to `Search.tsx`, `Timeline.tsx`, `useTimelineParams.ts`, `WorkerApiClient.ts`, `types/api.ts`.

---

### Task 1: Migration and schema

**Files:**
- Create: `worker/migrations/0018_known_people.sql`
- Modify: `worker/migrations/index.ts` (mirror, as 0017 is mirrored)
- Test: `worker/test/schema.test.ts`, `worker/test/query-plans.test.ts`

**Interfaces:**
- Produces: table `known_people (id TEXT PRIMARY KEY, name TEXT NOT NULL, aliases TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL)` (id is a Wikidata id such as `Q1234`; aliases is a JSON array of strings); `faces.known_id TEXT`, `faces.known_score REAL` (both nullable); partial index `idx_faces_known_photo ON faces (known_id, photo_id) WHERE known_id IS NOT NULL`.

- [ ] **Step 1: Write failing tests.** In `schema.test.ts`: `known_people` exists with those columns; `faces` has `known_id` and `known_score`; inserting a face without them still works (null). In `query-plans.test.ts`: `SELECT photo_id FROM faces WHERE known_id IN (?,?) GROUP BY photo_id HAVING COUNT(DISTINCT known_id) = ?` plan matches `/idx_faces_known_photo/` and not `SCAN faces`.
- [ ] **Step 2: Run** `cd worker && npx vitest run test/schema.test.ts test/query-plans.test.ts`. Expected: FAIL (missing table and columns).
- [ ] **Step 3: Write the migration** (additive: `CREATE TABLE IF NOT EXISTS`, two `ALTER TABLE ... ADD COLUMN`, the partial index) and mirror the statements in `index.ts`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(worker): known_people table and faces.known_id`.

### Task 2: Ingest known people (agent-only upsert)

**Files:**
- Create: `worker/src/routes/ingest-known.ts`
- Modify: `worker/src/index.ts` (register `app.post('/ingest/known-people', upsertKnownPeopleRoute)`)
- Test: `worker/test/ingest-known.test.ts`

**Interfaces:**
- Produces: `POST /ingest/known-people` body `{ people: { id: string; name: string; aliases: string[] }[] }` (1 to 500 people, name 1 to 200 chars, up to 20 aliases of 1 to 100 chars). Upserts all in one statement (`INSERT ... SELECT ... FROM json_each(?) ON CONFLICT(id) DO UPDATE`). Returns `{ upserted: number }`. 401 without the ingest token, 400 on invalid body.
- Exports `upsertKnownPeopleRoute`, and in the same file the routes of Tasks 3 and 4.

- [ ] **Step 1: Write failing tests:** upsert twice with a changed name leaves one row with the new name; aliases are stored as JSON; 501 people returns 400; read token returns 401; the Pages proxy cannot reach it (covered in Task 7).
- [ ] **Step 2: Run** `npx vitest run test/ingest-known.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `upsertKnownPeopleRoute(c: Context<{ Bindings: Env }>)` with zod/mini, following the `readJson` pattern in `ingest-faces.ts`.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5: Commit** `feat(worker): ingest known people`.

### Task 3: Faces carry a known match at ingest

**Files:**
- Modify: `worker/src/routes/ingest-faces.ts` (`faceSchema`, the INSERT)
- Test: `worker/test/ingest-faces.test.ts`

**Interfaces:**
- Consumes: Task 1 columns, Task 2 table.
- Produces: `faceSchema` gains `known: z.optional(z.object({ id: string(min 1), score: unit }))`. Ids not present in `known_people` are dropped silently (one `SELECT id FROM known_people WHERE id IN (SELECT value FROM json_each(?))`, run only when some face has `known`). Valid ones are written to `known_id` and `known_score` in the existing face INSERT.

- [ ] **Step 1: Write failing tests:** a face with a valid known id stores `known_id` and `known_score`; an unknown id stores nulls and the request still succeeds; a face with a known match and a confirmed overlapping face keeps the confirmed face's existing `known_id`; re-posting the photo without `known` leaves the replaced faces with null known (Review Focus 2); `person_id` and `assign_status` stay `NULL` and `'unassigned'` (a body containing `person_id` is still dropped).
- [ ] **Step 2: Run** `npx vitest run test/ingest-faces.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** the schema field, the validation query, and the INSERT columns.
- [ ] **Step 4: Run** the whole file. Expected: PASS.
- [ ] **Step 5: Commit** `feat(worker): store known matches on ingested faces`.

### Task 4: Embedding pages and batched known writes (for backfill)

**Files:**
- Modify: `worker/src/routes/ingest-known.ts`, `worker/src/index.ts`
- Test: `worker/test/ingest-known.test.ts`

**Interfaces:**
- Produces: `POST /ingest/faces/embeddings` body `{ model: string; cursor?: number; limit?: number (1 to 100, default 100); rescore?: boolean }`. Pages `faces` by rowid where `embedding_model = model` and (`rescore` or `known_id IS NULL`). Response is `application/octet-stream`: for each face, 36 bytes ASCII face id followed by the 2048 stored embedding bytes; next cursor in header `X-Next-Cursor` (absent on the last page). No JSON or base64.
- Produces: `POST /ingest/faces/known` body `{ matches: { faceId: string; knownId: string | null; score?: number }[] }` (1 to 200). One `UPDATE faces ... FROM json_each(?)`; a non-null `knownId` must exist in `known_people` (else 400 for the whole request); null clears. Returns `{ updated: number }`.

- [ ] **Step 1: Write failing tests:** page of 3 faces returns 3 x (36 + 2048) bytes with ids and the exact embedding bytes; faces of another model are excluded; faces with a known id are skipped unless `rescore`; the last page has no `X-Next-Cursor`; known write sets and clears; unknown `knownId` returns 400 and changes nothing; 201 matches returns 400.
- [ ] **Step 2: Run** `npx vitest run test/ingest-known.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `faceEmbeddingsRoute` and `setFaceKnownRoute`; register both under `/ingest/faces/...` (they do not clash with the `PUT /ingest/faces/:faceId/crop` route).
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5: Add a query-plan test** in `query-plans.test.ts` that the embeddings page query uses `rowid` range access on `faces`, then run it.
- [ ] **Step 6: Commit** `feat(worker): paged face embeddings and batched known writes`.

### Task 5: Viewer list of known personalities

**Files:**
- Create: `worker/src/routes/known.ts`
- Modify: `worker/src/index.ts` (`app.get('/people/known', listKnownRoute)` next to the other `/people` reads)
- Test: `worker/test/known-list.test.ts`

**Interfaces:**
- Produces: `GET /people/known` (READ_TOKEN plus `X-Viewer-Email`) returns `{ known: { id: string; name: string; aliases: string[]; photoCount: number }[] }`, only known people with at least one matched face in a photo in the viewer's visible albums (`scopeFor(user, 'p.album')`), `photoCount` is distinct visible photos, sorted by `photoCount` desc then name. Faces count whether or not they also have a `person_id`.

- [ ] **Step 1: Write failing tests:** owner sees a person with 2 photos; a viewer of a shared album sees the count for that album only; a user with no access gets an empty list and no names (Review Focus 3); a known person on a face that also has a confirmed `person_id` is still counted; a known person with no matched faces is not listed; missing `X-Viewer-Email` returns 401.
- [ ] **Step 2: Run** `npx vitest run test/known-list.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** one grouped query (`faces f JOIN photos p ON p.id = f.photo_id`, `f.known_id IS NOT NULL`, scope clause, `GROUP BY f.known_id`) then one lookup of names with `json_each`. State rows read in a comment (about one per matched visible face, bounded by matches).
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5: Add a query-plan test** that the grouped query searches `idx_faces_known_photo`. Run it.
- [ ] **Step 6: Commit** `feat(worker): GET /people/known`.

### Task 6: `known` filter on search and timeline

**Files:**
- Create: `worker/src/db/known.ts`
- Modify: `worker/src/routes/search.ts`, `worker/src/routes/timeline.ts` (`scopeSql`, `parsePeople` usage, buckets)
- Test: `worker/test/search.test.ts`, `worker/test/timeline.test.ts`

**Interfaces:**
- Produces in `known.ts`: `export const MAX_FILTER_PEOPLE = 5`; `export function parseKnown(raw: string | undefined, taken: number): string[]` (split on commas, trim, dedupe, cap at `MAX_FILTER_PEOPLE - taken`); `export function knownFilterSql(known: string[]): { sql: string; params: unknown[] }` returning an AND-clause ` AND photos.id IN (SELECT photo_id FROM faces WHERE known_id IN (...) GROUP BY photo_id HAVING COUNT(DISTINCT known_id) = ?)` (empty when none). Ids are always bound.
- Query param `known=<id,id>` on `/search`, `/timeline`, `/timeline/buckets`; the `unfiltered` fast path in `search.ts` must account for it.

- [ ] **Step 1: Write failing tests:** `known=Q1` returns only photos with that match; `known=Q1,Q2` is AND; `known` combined with `people` is AND across both; `people` ids fill the cap first so 5 people leave no room (Review Focus 4); unknown id returns zero results with 200; duplicate ids behave as one; a photo in an invisible album is never returned; timeline and buckets honour the same filter; the count (`total`) matches the filtered rows.
- [ ] **Step 2: Run** `npx vitest run test/search.test.ts test/timeline.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** the helper and wire it into both routes (replace the duplicated people parsing only where needed, keep behaviour for `people`).
- [ ] **Step 4: Run** both files and `npx vitest run`. Expected: PASS.
- [ ] **Step 5: Add a query-plan test** for the filter subquery (uses `idx_faces_known_photo`). Run it.
- [ ] **Step 6: Commit** `feat(worker): known filter on search and timeline`.

### Task 7: Pages proxy allowlist

**Files:**
- Modify: `functions/api/[[path]].ts` (add `/^people\/known$/` to `ALLOWED_PATHS`)
- Test: `functions/api/proxy.test.ts`

- [ ] **Step 1: Write failing tests:** `GET /api/people/known` is forwarded with the verified email and READ_TOKEN; `POST /api/ingest/known-people` and `POST /api/ingest/faces/known` and `/api/ingest/faces/embeddings` are refused (404 or 405, matching existing behaviour for `/ingest/*`); `GET /api/people/known` without a valid Access JWT is refused.
- [ ] **Step 2: Run** `npx vitest run functions/api/proxy.test.ts`. Expected: first test FAILS.
- [ ] **Step 3: Add the allowlist entry.**
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5: Commit** `feat(functions): proxy GET people/known`.

### Task 8: Agent gallery types, matcher and client methods

**Files:**
- Create: `agent/src/known/gallery.ts`, `agent/src/known/matcher.ts`
- Modify: `agent/src/cloudflareClient.ts`
- Test: `agent/test/known-matcher.test.ts`, `agent/test/known-gallery.test.ts`, `agent/test/cloudflareClient.test.ts`

**Interfaces:**
- `gallery.ts`: `interface KnownPerson { id: string; name: string; aliases: string[] }`; `interface GalleryPerson extends KnownPerson { refs: Float32Array[] }`; `interface Gallery { model: string; people: GalleryPerson[] }`; `decodeEmbedding(b64: string): Float32Array` (512 floats, L2-normalised, throws on bad input); `saveGallery(path: string, g: Gallery): Promise<void>` and `loadGallery(path: string): Promise<Gallery | undefined>` (JSON with base64 refs; `undefined` when the file is absent); `GALLERY_PATH` = `agent/.index-state/known-gallery.json`.
- `matcher.ts`: `export const KNOWN_THRESHOLD = 0.5; export const KNOWN_MARGIN = 0.05;` (initial values, to be tuned by the dry run in Task 11); `matchKnown(embedding: Float32Array, gallery: Gallery): { id: string; score: number } | null`. A person's score is the maximum cosine over its refs; return the best person only if its score is at least the threshold and exceeds the second-best person by at least the margin.
- `CloudflareClient`: `upsertKnownPeople(people: KnownPerson[]): Promise<number>`; `faceEmbeddingsPage(model: string, opts: { cursor?: number; rescore?: boolean }): Promise<{ faces: { id: string; embedding: Float32Array }[]; nextCursor?: number }>` (parses the Task 4 binary format); `setFaceKnown(matches: { faceId: string; knownId: string | null; score?: number }[]): Promise<number>`.

- [ ] **Step 1: Write failing tests:** `matchKnown` returns null below the threshold, null when two people are within the margin, and the right id when clear; refs of the same person do not count as a second-best person; `decodeEmbedding` rejects wrong length; save then load round-trips refs; `loadGallery` of a missing file is `undefined`; client methods hit the right paths with the ingest token and parse a two-face binary page into ids and exact floats.
- [ ] **Step 2: Run** `cd agent && npx vitest run test/known-matcher.test.ts test/known-gallery.test.ts test/cloudflareClient.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the three modules.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(agent): known gallery, matcher and client methods`.

### Task 9: Build the gallery from Wikidata and Commons

**Files:**
- Create: `agent/known/people.json`, `agent/src/known/wikimedia.ts`, `agent/src/known/buildGallery.ts`
- Modify: `agent/src/cli.ts` (new command `build-known-gallery`)
- Test: `agent/test/known-wikimedia.test.ts`, `agent/test/known-build.test.ts`, `agent/test/cli.test.ts`

**Interfaces:**
- `people.json`: array of `KnownPerson` (Wikidata id, display name, aliases), created and verified in Task 9b.
- `wikimedia.ts`: `class WikimediaClient { constructor(fetchFn?: typeof fetch, delayMs?: number) }` with `portrait(qid: string): Promise<string | undefined>` (Wikidata P18 file title), `categoryFiles(qid: string, opts: { maxDepth: number; limit: number }): Promise<string[]>` (Commons category from Wikidata P373 and its subcategories), `fileInfo(title: string): Promise<{ thumbUrl: string; license: string } | undefined>`, and `isOpenLicense(license: string): boolean` (CC0, CC BY, CC BY-SA and public domain only). Generic User-Agent, a minimum delay between requests, retry once on 429.
- `buildGallery.ts`: `buildGallery(deps: { people: KnownPerson[]; existing?: Gallery; rebuild?: string[]; wikimedia: WikimediaClient; sidecar: FaceSidecarClient; download: (url: string) => Promise<Buffer>; onProgress?: (m: string) => void }): Promise<{ gallery: Gallery; report: GalleryReport }>` is incremental: people already in `existing` (same model) keep their refs and are not fetched again unless their id is in `rebuild`; people removed from `people` are dropped; and with constants `MAX_REFS = 10`, `MIN_REFS = 3`, `MIN_DET_SCORE = 0.6`, `OUTLIER_COSINE = 0.35`. Per person: collect candidate files (portrait first, then category files), keep images that yield exactly one face with `detScore >= MIN_DET_SCORE`, drop refs whose cosine to the median reference is below `OUTLIER_COSINE`, cap at `MAX_REFS`; exclude people below `MIN_REFS`. `GalleryReport = { included: { id: string; name: string; refs: number }[]; excluded: { id: string; name: string; refs: number }[]; averageRefs: number }`.
- CLI `build-known-gallery [--rebuild <id>...] [--full]`: needs `FACE_SIDECAR_URL`; loads the existing gallery (ignored with `--full`), builds incrementally, saves to `GALLERY_PATH`, upserts the included people with `upsertKnownPeople`, prints the report including average refs per person and the excluded list.

- [ ] **Step 1: Write failing tests (all with injected fakes, no network):** a second build with one new person fetches only that person and keeps the others' refs untouched; `rebuild` refetches just the named id; a person removed from the list leaves the gallery; a gallery of another model is ignored (full rebuild); `isOpenLicense` accepts "CC BY-SA 4.0", "CC0", "Public domain" and rejects "CC BY-NC 4.0" and "All rights reserved"; `categoryFiles` stops at `maxDepth` and `limit`; a person with 2 usable images is excluded and listed; images with two faces or low `detScore` are skipped; an outlier ref is dropped; the cap is 10; `averageRefs` is computed over included people; the CLI test asserts the command saves the gallery and upserts only included people, and errors with the existing message style when `FACE_SIDECAR_URL` is unset.
- [ ] **Step 2: Run** `npx vitest run test/known-wikimedia.test.ts test/known-build.test.ts test/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the client, builder and CLI wiring.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(agent): build-known-gallery from Wikimedia`.

### Task 9b: The curated list (at least 200 people) and the add-a-person process

**Files:**
- Create: `agent/known/people.json`, `agent/known/README.md`, `agent/src/known/list.ts`
- Modify: `agent/src/cli.ts` (commands `known-add`, `known-check`, `known-search`), `agent/src/known/wikimedia.ts` (Wikidata search and entity details)
- Test: `agent/test/known-list.test.ts`, `agent/test/cli.test.ts`

**Interfaces:**
- `people.json` has at least 200 `KnownPerson` entries, India first (cricketers and other sport, Hindi and South Indian film, music, politics, business, public life), then global names. Every id is verified against Wikidata, not typed from memory: instance of human, English label close to the name, at least one of a portrait (P18) or a Commons category (P373). The file is sorted by name and formatted so a diff shows one person per few lines.
- `list.ts`: `loadList(path: string): Promise<KnownPerson[]>`; `saveList(path: string, people: KnownPerson[]): Promise<void>` (sorted, stable formatting); `searchWikidata(query: string, deps: { fetchFn?: typeof fetch }): Promise<Candidate[]>` where `Candidate = { id: string; label: string; description: string; sitelinks: number; hasPortrait: boolean; hasCategory: boolean; isHuman: boolean }`, humans first then by sitelinks; `checkList(people: KnownPerson[], opts: { online: boolean; fetchFn?: typeof fetch }): Promise<CheckIssue[]>` with `CheckIssue = { id: string; name: string; problem: string }` (schema, duplicate ids, duplicate names, alias equal to the name, non-human, label mismatch, no portrait and no category; the online checks run in batches of 50 ids).
- CLI: `known-search "<name>"` prints candidates; `known-add --id <Q...> [--name "<display name>"] [--alias <a>]...` appends after the checks pass (refuses duplicates, non-humans and ids with neither portrait nor category) and keeps the file sorted; `known-check [--offline]` prints issues and exits 1 when any exist.
- `agent/known/README.md` documents the process: pick who to add (people who plausibly appear in your photos; India first; prefer ones with several openly licensed Commons photos), `known-search`, `known-add`, `known-check`, `build-known-gallery` (incremental, fetches only the new people and reports reference counts), `backfill-known` (fills faces with no known match yet; use `--rescore` only after threshold changes, since a face already matched to someone else is not reconsidered), how to remove a person (delete the entry, rebuild, then `backfill-known --rescore` to clear their old matches), and how to fix a weak person (`build-known-gallery --rebuild <id>`).

- [ ] **Step 1: Write failing tests (fake `fetchFn`):** `checkList` flags duplicate ids, duplicate names, an alias equal to the name, a non-human, a label mismatch, and an entry with no portrait and no category, and passes a clean list; `--offline` skips network checks; `searchWikidata` orders humans first then by sitelinks; `known-add` refuses a duplicate id and a non-human, appends a valid one with aliases, keeps the file sorted and stable (running it twice with the same input changes nothing); `known-check` exits 1 with issues and 0 without. A test loads the committed `people.json` and asserts it has at least 200 entries, passes `checkList(..., { online: false })`, and every entry has a name of at least 2 characters.
- [ ] **Step 2: Run** `cd agent && npx vitest run test/known-list.test.ts test/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `list.ts`, the Wikidata helpers and the three commands.
- [ ] **Step 4: Verify the seed list.** `agent/known/people.json` already exists in the working tree (uncommitted, 405 entries, 91 with aliases): resolved against Wikidata on 2026-11-12, humans only, each with a portrait or Commons category, every chosen description reviewed by eye, and seven wrong namesakes corrected by hand (Steve Smith, David Warner, Nagarjuna, Yash, Darshan, Badshah; Yuvraj Singh dropped because no reliable id was found). Run `npx tsx --env-file=.env src/cli.ts known-check` (online); fix or remove any entry it flags. Expected: no issues. The gallery build later reports how many of the 405 have enough openly licensed photos (at least 3); the count that makes it into the gallery will be lower than 405 and is reported, not hidden.
- [ ] **Step 5: Run** `npx vitest run test/known-list.test.ts test/cli.test.ts` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(agent): curated known list and add-a-person process`.

### Task 10: Match known people at scan time

**Files:**
- Modify: `agent/src/faces/scanFaces.ts`, `agent/src/cloudflareClient.ts` (`FacePayload`), `agent/src/backfillFaces.ts` and the other call sites that pass `sidecar` to `scanFaces` (find with grep), `agent/src/cli.ts` (load the gallery once)
- Test: `agent/test/scanFaces.test.ts`, `agent/test/backfillFaces.test.ts`

**Interfaces:**
- `FacePayload` gains `known?: { id: string; score: number }`. `scanFaces` deps gain `gallery?: Gallery`. For each kept face, `matchKnown(decodeEmbedding(face.embedding), gallery)`; when `gallery.model !== detection.model`, skip matching and call `onWarning` once (new optional dep `onWarning?: (m: string) => void`).
- Gallery is loaded with `loadGallery(GALLERY_PATH)` once per CLI command and passed down; absent means no known matching and no error.

- [ ] **Step 1: Write failing tests:** a face above threshold produces `known` in the posted payload; a gallery with a different model posts no `known` and warns once (Review Focus 1); no gallery posts none; the payload order and faceIds mapping are unchanged.
- [ ] **Step 2: Run** `npx vitest run test/scanFaces.test.ts test/backfillFaces.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the dep and the per-face match; wire `loadGallery` in the commands that scan (`index-local`, `index-drive`, `index-batch`, `backfill-faces`).
- [ ] **Step 4: Run** `cd agent && npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(agent): known matching during face scans`.

### Task 11: `backfill-known` with dry run

**Files:**
- Create: `agent/src/backfillKnown.ts`
- Modify: `agent/src/cli.ts` (`backfill-known [--dry-run] [--rescore]`, and the usage string)
- Test: `agent/test/backfillKnown.test.ts`, `agent/test/cli.test.ts`

**Interfaces:**
- `backfillKnown(deps: { cloudflareClient: CloudflareClient; gallery: Gallery; model: string; dryRun?: boolean; rescore?: boolean; onProgress?: (m: string) => void }): Promise<BackfillKnownResult>` where `BackfillKnownResult = { scanned: number; matched: number; written: number; perPerson: { id: string; name: string; count: number }[]; scoreBuckets: Record<string, number>; samples: { faceId: string; knownId: string; score: number }[] }`. Pages embeddings with `faceEmbeddingsPage`, matches locally, writes matches in batches of 200 with `setFaceKnown` (skipped in `dryRun`). Without `rescore`, only faces with no known match are paged. With `rescore`, faces that no longer match are cleared (`knownId: null`).
- The CLI refuses when the gallery file is missing (message pointing at `build-known-gallery`), prints the result (counts, top 20 people, score histogram in 0.05 buckets, 10 samples with face ids), and in dry run prints that nothing was written.

- [ ] **Step 1: Write failing tests:** dry run writes nothing and returns counts; normal run writes only matched faces in batches of at most 200; `rescore` clears a face that no longer matches and passes `rescore` to the page call; model mismatch between `model` and `gallery.model` throws; a Worker error mid-run stops with the error and leaves earlier batches written (idempotent re-run).
- [ ] **Step 2: Run** `npx vitest run test/backfillKnown.test.ts test/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the function and CLI wiring.
- [ ] **Step 4: Run** `cd agent && npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(agent): backfill-known with dry run and rescore`.

### Task 12: Frontend data layer and shared matcher

**Files:**
- Create: `src/services/personMatch.ts`
- Modify: `src/types/api.ts`, `src/services/api/WorkerApiClient.ts`
- Test: `src/services/__tests__/personMatch.test.ts`, `src/services/api/__tests__/WorkerApiClient.test.ts` (or the existing client test file)

**Interfaces:**
- `api.ts`: `interface KnownPersonSummary { id: string; name: string; aliases: string[]; photoCount: number }`.
- `WorkerApiClient`: `getKnownPeople(): Promise<KnownPersonSummary[]>` (`GET /people/known`); `SearchParams` and `getTimeline` and `getTimelineBuckets` accept `known?: string[]` sent as `known=<comma list>`.
- `personMatch.ts`: `normalizeName(s: string): string` (NFD, strip diacritics, lowercase, replace `.-_'` with space, collapse spaces, trim); `matchesQuery(query: string, names: string[], min = 3): boolean` (true when the normalised query has at least `min` characters and every query word is a prefix of some word of some name; empty or short queries return true only when the query is empty, so an empty box lists everything).

- [ ] **Step 1: Write failing tests:** `matchesQuery('dho', ['MS Dhoni'])`, `('virat k', ['Virat Kohli'])`, `('kohli virat', ...)`, `('ar rahman', ['A. R. Rahman'])`, `('msd', ['MS Dhoni', 'MSD'])` true; `('xyz', ...)` false; accent insensitive (`'beyonce'` matches `'Beyoncé'`); `('.', ...)` and `('..', ...)` do not match everything (Review Focus 5); client sends `known` and calls `/people/known`.
- [ ] **Step 2: Run** `npx vitest run src/services`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): known people client and shared matcher`.

### Task 13: The combined People filter on Search and Timeline

**Files:**
- Create: `src/components/PeopleFilter.tsx`
- Modify: `src/components/Search.tsx`, `src/components/Timeline.tsx`, `src/hooks/useTimelineParams.ts`
- Test: `src/components/__tests__/PeopleFilter.test.tsx`, `src/components/__tests__/Search.test.tsx`, `src/components/__tests__/Timeline.test.tsx`

**Interfaces:**
- `PeopleFilter` props: `{ people: string[]; known: string[]; onChange: (next: { people: string[]; known: string[] }) => void }`. It loads `['people']` and `['known-people']` (staleTime 5 minutes) itself, renders a Mantine `MultiSelect` labelled "People" with two groups ("Your people", then "Known personalities in your photos"), internal values prefixed `p:` and `k:` so ids never collide, a custom `filter` using `matchesQuery` over name and aliases (own names first on ties), maximum 5 values combined, hidden when both lists are empty. Own entries use blue, known entries violet, and known entries also show a small "known" marker; picked tags carry the same colour (verify what Mantine 9 `MultiSelect` exposes for per-value pills; if it has no per-value pill styling, prefix the label with the marker and colour via a custom `renderOption` and the group heading).
- URL: `known` param (comma list, deduped, capped so `people.length + known.length <= 5`) in `Search.tsx` and `useTimelineParams.ts`; changing either resets the page; the `search`, `timeline` and `timeline-buckets` query keys include `known`; ids not in either list are dropped from the selection like `people` today.

- [ ] **Step 1: Write failing tests:** with only known people present the "People" box still renders (today it hides); typing "dho" shows the known group entry; picking one sets `known` in the URL and the search call includes `known`; own and known entries for the same name both appear, own first, with distinct markers; 6th selection is refused; both lists empty hides the box; Timeline behaves the same; an old URL with only `people` works unchanged.
- [ ] **Step 2: Run** `npx vitest run src/components/__tests__/PeopleFilter.test.tsx src/components/__tests__/Search.test.tsx src/components/__tests__/Timeline.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the component and replace the two inline `MultiSelect` People boxes.
- [ ] **Step 4: Run** `npm test && npm run lint && npm run build`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(web): known personalities in the People filter`.

### Task 14: Docs, performance notes and rollout

**Files:**
- Modify: `README.md`, `AGENTS.md`, `docs/architecture.md`, `docs/development.md`, `agent/sidecar/README.md` if it lists commands; run `graphify update .`

- [ ] **Step 1: Document** the new tables, routes, `known` param, agent commands (`known-search`, `known-add`, `known-check`, `build-known-gallery`, `backfill-known [--dry-run] [--rescore]`), gallery location, colour rule, the 5-people combined cap, and the performance review (rows read and written per route, no Worker embedding loops, the grouped list query and its index, expected backfill time of 1 to 3 minutes for about 5K photos as an estimate to measure).
- [ ] **Step 2: Document the rollout order:** merge applies migration 0018 before the Worker deploys; then on the owner's machine run `known-check`, `build-known-gallery`, then `backfill-known --dry-run`, tune `KNOWN_THRESHOLD` and `KNOWN_MARGIN` from the output, then `backfill-known`. Measure with `wrangler tail` and `wrangler d1 insights` (list the commands in `docs/development.md`).
- [ ] **Step 3: Verify everything:** run `npm test && npm run lint && npm run build`, `cd worker && npm test && npm run typecheck`, `cd agent && npm test && npm run typecheck`. Expected: all pass.
- [ ] **Step 4: Commit** `docs: known personalities phase 1`.
