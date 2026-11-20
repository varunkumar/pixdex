# Album people and species tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The album page gets Photos | People | Species tabs; clicking a person or species tile filters the album's photos in place.

**Architecture:** A new Worker read `GET /albums/contents` computes per-album people, known and species lists live (no migration); `/search` gains an album-scoped `species=` filter. The album page loads the lists after its photo grid, keeps tab and filter in the URL, and shows tiles plus a removable filter chip.

**Tech Stack:** Cloudflare Worker (Hono, D1, `zod/mini`, vitest pool-workers), React 19, Mantine, React Query, react-router.

**Spec:** `docs/superpowers/specs/2026-11-20-album-people-species-design.md`

Work on a branch (`feat/album-people-species`, in a worktree under `.claude/worktrees/`) and open a PR; pushing to `main` deploys. The pre-commit hook runs the touched suites; do not bypass it.

## Global Constraints

- Each list (`people`, `known`, `species`) is capped at 200, sorted by count descending, then name.
- Species are grouped by `scientific` name (from `json_each(photos.species)`); photos with `species` NULL contribute nothing.
- Names: only through `PERSON_NAME_SQL` (`worker/src/db/faces.ts`, binds from `nameBinds(user)`); never select `p.name` raw. Null name is shown as "Unnamed".
- Every query is scoped with `scopeFor(user, 'photos.album')`; an invisible album is 404, an empty one returns empty lists.
- `zod/mini` in `worker/`; no new migration; emails lowercase.
- Colours only from `src/components/chipStyle.ts` plus `--pixdex-ink-*` in `src/index.css`: people blue, known violet with a "known" marker, species green.
- One filter at a time in the URL. Precedence when several are present: `people`, then `known`, then `species`; the rest are dropped.
- `/albums/contents` is a browser read, so it goes in the Pages Function GET allowlist; `/ingest/*` stays out.
- State the performance result (rows read and written, CPU) in the final summary. It cannot be measured locally; list `wrangler tail`, `wrangler d1 insights`.
- Update `README.md`, `AGENTS.md` and `docs/` in the same change (Task 6).

## Review Focus

- A photo whose `species` is NULL or `'[]'` must not break the species list or the `species=` filter (and malformed JSON must not 500 the album; guard with `json_valid`).
- A person with only rejected or unassigned faces in the album gets no tile (only `auto` and `confirmed` count).
- A viewer sees another owner's person with their own label or "Unnamed", never `persons.name`.
- A stranger asking for a private album's contents gets 404, never an empty 200 that reveals the album exists.
- A deep link `?species=Elephas%20maximus` before the lists load shows a chip (scientific name) and the filtered photos; an unknown species gives an empty grid with the chip, not an error.
- Album names with `/`, `#`, `&` or non-ASCII characters round-trip through `contents` and the filter.

---

## File Structure

- Create `worker/src/db/species.ts` - `speciesFilterSql`, shared SQL for species grouping.
- Create `worker/src/routes/album-contents.ts` - `albumContentsRoute`.
- Modify `worker/src/routes/search.ts`, `worker/src/index.ts`.
- Modify `functions/api/[[path]].ts`.
- Modify `src/types/api.ts`, `src/services/api/WorkerApiClient.ts`, `dev/mockApi.ts`.
- Create `src/services/albumFilter.ts`, `src/components/AlbumTiles.tsx` (people and species tile grids), `src/components/AlbumFilterChip.tsx`.
- Modify `src/components/AlbumPhotos.tsx`, `src/components/chipStyle.ts`, `src/index.css`.

### Task 1: `species=` filter on `/search`

**Files:**
- Create: `worker/src/db/species.ts`
- Modify: `worker/src/routes/search.ts:12-60`
- Test: `worker/test/species-filter.test.ts`, `worker/test/query-plans.test.ts`

**Interfaces:**
- Produces: `speciesFilterSql(scientific: string | undefined): { sql: string; params: unknown[] }` - an AND clause on `photos.species` (empty when undefined, blank, or longer than 200 characters); the scientific name is bound, never interpolated.

- [ ] **Step 1: Write the failing tests** in `species-filter.test.ts` (model on `known-filter.test.ts`): `GET /search?album=A&species=Elephas%20maximus` returns only photos of album A whose species JSON has that scientific name; a NULL-species photo and a `'[]'` photo are never returned and cause no error; an unknown name gives `total: 0`; combined with `people=<id>` it ANDs; a stranger gets no photos from a private album; a photo with invalid JSON in `species` does not 500 the request (insert with `json_valid` false, expect 200).
- [ ] **Step 2: Run** `cd worker && npx vitest run test/species-filter.test.ts` - expect FAIL (filter ignored).
- [ ] **Step 3: Implement** `speciesFilterSql` as ``AND json_valid(photos.species) AND EXISTS (SELECT 1 FROM json_each(photos.species) WHERE json_extract(value, '$.scientific') = ?)`` and add it in `run()` after the album and scope clauses; include it in the `unfiltered` check.
- [ ] **Step 4: Add a query-plan test** in `query-plans.test.ts`: with `album = ?` the plan uses `idx_photos_album`, so the `json_each` check runs only on that album's rows.
- [ ] **Step 5: Run** `cd worker && npm test && npm run typecheck` - expect PASS.
- [ ] **Step 6: Commit** `feat(worker): species filter on search`.

### Task 2: `GET /albums/contents`

**Files:**
- Create: `worker/src/routes/album-contents.ts`
- Modify: `worker/src/index.ts` (next to `/albums`, line ~111: `app.use('/albums/contents', requireReadToken); app.get('/albums/contents', albumContentsRoute);`)
- Test: `worker/test/album-contents.test.ts`, `worker/test/query-plans.test.ts`, `worker/test/sharing-reads.test.ts` (add the route to the reads that need `X-Viewer-Email`)

**Interfaces:**
- Produces response `{ people: AlbumPersonTile[]; known: AlbumKnownTile[]; species: AlbumSpeciesTile[] }`:
  - `AlbumPersonTile = { id: string; name: string | null; canEdit: boolean; photoCount: number; cover: SerializedFace | null }`
  - `AlbumKnownTile = { id: string; name: string; photoCount: number; cover: SerializedFace | null }`
  - `AlbumSpeciesTile = { scientific: string; common: string; photoCount: number; coverPhotoId: string; thumbnailUrl: string }` (`thumbnailUrl` is `/thumbnails/<content_hash>` like faces).
- Consumes: `scopeFor`, `PERSON_NAME_SQL`, `nameBinds`, `serializeFace` (`worker/src/db/faces.ts`), `userOf`.
- Query: `name` required (400 if missing); 404 if the album is not visible to the caller.

- [ ] **Step 1: Write the failing tests** in `album-contents.test.ts` (fixtures as in `known-list.test.ts`): owner sees people with distinct-photo counts (two faces of one person in one photo count once); rejected and unassigned faces give no person tile; known tiles count faces with a `known_id` whether or not a person is set; species grouped by scientific name with counts and the highest-score photo as cover; a viewer (album shared) sees owner's person with their own `person_labels` name, and `null` with none, and never `persons.name` (assert the raw name is absent from the JSON text); a stranger gets 404 for a private album; an empty album gives three empty lists; 250 distinct species return exactly 200; person cover is `cover_face_id` when it is in the album, else highest `det_score` confirmed, else auto; a missing token is 401 and a missing `X-Viewer-Email` is 401.
- [ ] **Step 2: Run** `cd worker && npx vitest run test/album-contents.test.ts` - expect FAIL (404 route).
- [ ] **Step 3: Implement** `albumContentsRoute(c: Context<{ Bindings: Env }>)` in one `DB.batch` of set-based statements (people, known, species, plus a covers statement using a window function over the album's faces, not one query per tile). Guard species with `json_valid`. Photo-driven: start from `photos WHERE album = ?` (index `idx_photos_album`) and join `faces` on `idx_faces_photo_id`.
- [ ] **Step 4: Add query-plan tests**: the photos side uses `idx_photos_album`, the faces side `idx_faces_photo_id`, no full `SCAN photos`.
- [ ] **Step 5: Run** `cd worker && npm test && npm run typecheck` - expect PASS (including `sharing-writes.test.ts` unaffected).
- [ ] **Step 6: Commit** `feat(worker): album contents endpoint`.

### Task 3: Proxy, client, types and mock API

**Files:**
- Modify: `functions/api/[[path]].ts:44` (add `/^albums\/contents$/` to `ALLOWED_PATHS`), `functions/api/proxy.test.ts`
- Modify: `src/types/api.ts`, `src/services/api/WorkerApiClient.ts`, `dev/mockApi.ts`

**Interfaces:**
- Produces in `src/types/api.ts`: `AlbumPersonTile`, `AlbumKnownTile`, `AlbumSpeciesTile`, `AlbumContents` (same shapes as Task 2; `cover` is `SerializedFace | null`).
- Produces in `WorkerApiClient`: `getAlbumContents(album: string): Promise<AlbumContents>` (`GET /albums/contents?name=`); `SearchParams` gains `species?: string`, sent as `species=` by `searchPage`.

- [ ] **Step 1: Write the failing test** in `proxy.test.ts`: `GET /api/albums/contents?name=A` is forwarded with the read token and `X-Viewer-Email`; `GET /api/ingest/...` still 404s.
- [ ] **Step 2: Run** `npx vitest run functions/api/proxy.test.ts` - expect FAIL.
- [ ] **Step 3: Implement** the allowlist entry, types, client method and `species` param. In `dev/mockApi.ts` return a small dummy `AlbumContents` (3 people, 1 known, 5 species) for `/albums/contents` and honour `species=` and `people=` in the mocked search.
- [ ] **Step 4: Run** `npm test && npm run lint` - expect PASS.
- [ ] **Step 5: Commit** `feat: proxy, client and mock for album contents`.

### Task 4: Filter state and chip

**Files:**
- Create: `src/services/albumFilter.ts`, `src/components/AlbumFilterChip.tsx`
- Modify: `src/components/chipStyle.ts` (add `SPECIES_COLOR = 'green'`; extend `kindColor` for `'species'`), `src/index.css` (`--pixdex-ink-green` in light and dark, like blue)
- Test: `src/services/__tests__/albumFilter.test.ts`, `src/components/__tests__/AlbumFilterChip.test.tsx`

**Interfaces:**
- Produces: `type AlbumFilter = { kind: 'people' | 'known' | 'species'; value: string }`; `parseAlbumFilter(params: URLSearchParams): AlbumFilter | null` (precedence people, known, species; first id only for people and known); `filterPatch(filter: AlbumFilter | null): Record<string, string | null>` (a `useListParams().update` patch that sets that param and clears the other two); `AlbumFilterChip({ label, kind, onClear, href? }: ...)` renders `[label ✕]` coloured by `kindColor`, with an optional "View all photos of <label>" link.

- [ ] **Step 1: Write the failing tests**: `parseAlbumFilter(new URLSearchParams('people=a&known=Q1&species=x'))` returns `{kind:'people', value:'a'}`; only `known=Q1,Q2` returns `Q1`; `species=Elephas%20maximus` round-trips; none returns null; `filterPatch` clears the other two; the chip has an accessible "Clear filter" button that calls `onClear`, and known/species chips carry colour via `kindColor`, known with the text "known".
- [ ] **Step 2: Run** `npx vitest run src/services/__tests__/albumFilter.test.ts src/components/__tests__/AlbumFilterChip.test.tsx` - expect FAIL.
- [ ] **Step 3: Implement** the helpers and the chip.
- [ ] **Step 4: Run** the same command - expect PASS; then `npm run lint`.
- [ ] **Step 5: Commit** `feat: album filter state and chip`.

### Task 5: Tabs and tiles on the album page

**Files:**
- Create: `src/components/AlbumTiles.tsx` - `PeopleTiles({ people, known, onPick })`, `SpeciesTiles({ species, onPick })`
- Modify: `src/components/AlbumPhotos.tsx`
- Test: `src/components/__tests__/AlbumPhotos.test.tsx` (extend; add `getAlbumContents` to its `vi.mock`), `src/components/__tests__/AlbumTiles.test.tsx`

**Interfaces:**
- Consumes: `getAlbumContents`, `parseAlbumFilter`, `filterPatch`, `AlbumFilterChip`, `FaceTile` (round crop via `cropUrl`), `useListParams().update`.
- Behaviour: Mantine `Tabs` driven by `?tab=people|species` (absent is Photos). Query key `['album-contents', name]`, `staleTime` 5 minutes, `enabled` only once the photos query has data. A tab and its count show only when its list is non-empty (known tiles share the People tab, own people first). `onPick` sets the filter patch and `tab` to null with `resetPage: true`. The Photos tab passes `people`, `known` or `species` to `searchPage` and shows the chip and `data.total`. Chip label falls back to "Person" or the scientific name until the lists load. Tiles: people round, species square with thumbnail; 2 columns on phone, 6 on desktop (`SimpleGrid cols={{ base: 2, sm: 4, lg: 6 }}`); each tile is a button with the name and "N photos".
- A contents error shows one line of text and leaves Photos usable.

- [ ] **Step 1: Write the failing tests**: tabs appear only with data and show counts; clicking a person tile calls `searchPage` with `{ album, people: ['p1'], ... }` and shows the chip `Asha`; clicking a known tile uses `known`; clicking a species tile uses `species`; clearing the chip drops the param; `?people=p1&species=x` in the URL filters only by `people`; a deep link `?species=Elephas%20maximus` before contents load calls `searchPage` with `species` and shows the scientific name chip; an empty contents response hides People and Species tabs; a contents error shows a message and the grid still renders; a person with `name: null` shows "Unnamed"; changing a filter removes `page` from the URL.
- [ ] **Step 2: Run** `npx vitest run src/components/__tests__/AlbumPhotos.test.tsx src/components/__tests__/AlbumTiles.test.tsx` - expect FAIL.
- [ ] **Step 3: Implement** the components and wire `AlbumPhotos.tsx`, keeping existing owner controls (Share, cover buttons) working on the Photos tab.
- [ ] **Step 4: Run** `npm test && npm run lint && npm run build` - expect PASS.
- [ ] **Step 5: Check in a real browser** with `PIXDEX_MOCK=1 npm run dev`: desktop and a 390px viewport, light and dark; tabs, tile click, chip clear, deep link.
- [ ] **Step 6: Commit** `feat: people and species tabs on the album page`.

### Task 6: Docs and graph

**Files:**
- Modify: `AGENTS.md` (Layout: album page tabs, `GET /albums/contents`, `species=` filter, `SPECIES_COLOR`, performance paragraph), `README.md`, `docs/architecture.md`

- [ ] **Step 1: Update the three docs** to describe the endpoint, filter, URL params (`tab`, `species`), the 200 cap, name privacy and the performance review: rows read about the album's photo count plus its faces, 0 written, `json_each` runs in D1, UNMEASURED with how to measure (`wrangler tail`, `wrangler d1 insights`, `EXPLAIN QUERY PLAN`), and the fallback of a `photo_species` table (approach 2) if big albums are slow.
- [ ] **Step 2: Run** `graphify update .` and the full suites: `npm test`, `cd worker && npm test && npm run typecheck`.
- [ ] **Step 3: Commit** `docs: album people and species tabs`.
