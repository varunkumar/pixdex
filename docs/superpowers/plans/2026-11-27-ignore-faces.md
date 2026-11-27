# Ignore Faces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Album owners can ignore and restore faces; ignored faces leave groups, matching and known-person views.

**Architecture:** A nullable `faces.ignored_at` column, partial indexes that skip ignored rows, three Worker routes,
and controls on the People and photo pages.

**Tech Stack:** Hono, D1, zod/mini, React 19, Mantine, TanStack Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-27-ignore-faces-design.md`

## Global Constraints

- Additive migration `0021_face_ignore.sql`, mirrored in `worker/migrations/index.ts`.
- `ignored_at IS NOT NULL` implies `assign_status = 'unassigned'` and `person_id IS NULL`.
- Writes use `guardedWrite`; owner of the album only (404 not visible, 403 visible); `faceIds` 1 to 200; set-based.
- Ingest and agent bodies never set `ignored_at`. `agent/` is not modified; the running indexer is not touched.
- `worker/` imports `* as z from 'zod/mini'`. No em dashes in any text.

## Review Focus

- Ignore a group while background matching has just matched one of its faces: that face is skipped, the rest ignored.
- Bulk ignore stamps one timestamp on many faces: ignored list paging must not skip or repeat ties.
- Rescan of a photo whose ignored face has a rejection and a crop: both survive.
- A malformed or foreign cursor on `GET /people/ignored`: 400, never an error page.
- A mixed owned and foreign `faceIds` list: nothing changes.

---

### Task 1: Migration and indexes
**Files:** Create `worker/migrations/0021_face_ignore.sql`; modify `worker/migrations/index.ts`; test `worker/test/schema.test.ts`, `worker/test/query-plans.test.ts`.
**Produces:** column `faces.ignored_at TEXT`; indexes `idx_faces_ignored (ignored_at) WHERE ignored_at IS NOT NULL`,
`idx_faces_open_status (assign_status) WHERE ignored_at IS NULL`,
`idx_faces_known_shown (known_id, photo_id) WHERE known_id IS NOT NULL AND ignored_at IS NULL`; old
`idx_faces_assign_status` and `idx_faces_known_photo` dropped.
- [ ] Failing tests: column nullable; groups plan uses `idx_faces_open_status (assign_status=? AND rowid>?)`; known list plan `COVERING INDEX idx_faces_known_shown`; `knownFilterSql` plan uses it.
- [ ] Add the SQL, run `npx vitest run schema query-plans`, commit.

### Task 2: Exclude ignored faces everywhere
**Files:** `worker/src/routes/people.ts`, `people/autoMatch.ts`, `db/faces.ts`, `db/known.ts`, `routes/known.ts`, `routes/album-contents.ts`, `routes/ingest-faces.ts`; test `worker/test/face-ignore.test.ts`.
**Produces:** `SerializedFace.ignored: boolean`; `confirmFacesStmts` clears `ignored_at`.
- [ ] Failing tests, one per path: groups; match (suggest and apply); `autoMatchFaces`; references after naming; assign clears the flag; rescan keeps row, crop, rejection, counts `kept`, returns its id; ingest body `ignoredAt` is dropped; `/people/known`, `known=` on search and timeline, album known tile and cover.
- [ ] Add `ignored_at IS NULL` per the spec's list; rescan preserves `(+assign_status = 'confirmed' OR ignored_at IS NOT NULL)`; run `npm test`, `npm run typecheck`, commit.

### Task 3: Routes and proxy
**Files:** `worker/src/routes/faces.ts`, `routes/people.ts`, `src/index.ts`, `functions/api/[[path]].ts`; tests `face-ignore.test.ts`, `sharing-writes.test.ts`, `query-plans.test.ts`, `functions/api/proxy.test.ts`.
**Produces:** `POST /faces/ignore` → `{ ignored: number }`; `POST /faces/restore` → `{ restored: number }`;
`GET /people/ignored?cursor=` → `{ faces: SerializedFace[], nextCursor: string | null }`, 60 per page
(`IGNORED_PAGE_SIZE`), cursor `<ignored_at>|<rowid>`, exported `ignoredFacesSql(after: boolean)`.
- [ ] Failing tests: Review Focus 1, 2, 4, 5; restore; 201 ids is 400; viewer 403, stranger 404; plan uses `idx_faces_ignored` with no temp b-tree; proxy forwards all three.
- [ ] Implement, run worker and root tests, commit.

### Task 4: Frontend
**Files:** `src/types/api.ts`, `src/services/api/WorkerApiClient.ts`, `src/services/matchQueue.ts`, `src/components/People.tsx`, new `src/components/IgnoredFaces.tsx`, `PhotoFaces.tsx`; component tests.
**Produces:** client `ignoreFaces(ids): Promise<void>`, `restoreFaces(ids): Promise<void>` (both batch by 200),
`getIgnoredFaces(cursor?)`; `refreshAfterIgnoring(client, ids)` and `refreshAfterRestoring(client)`.
- [ ] Failing tests: "Ignore group" sends all ids and the card leaves without refetching groups; "Ignore face N of M" sends one; "Ignored faces" fetches only when opened, restore, "Restore all shown", "Load more"; photo page Ignore on unnamed, Restore only on ignored, nothing for viewers.
- [ ] Implement, run `npm test`, `npm run lint`, `npm run build`, commit.

### Task 5: Mock, docs, verification, PR
**Files:** `dev/mockApi.ts`, `README.md`, `AGENTS.md`, `docs/architecture.md`, `docs/development.md`.
- [ ] Mock sample groups and the three routes; check People and photo pages in a browser, light and dark.
- [ ] Update docs, `graphify update .`, run all suites, re-check `origin/main`, push, open the PR (no merge).
