# Confirm auto-matched faces: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline). Steps use checkboxes.

**Goal:** A person's owner can confirm auto-matched faces, one photo at a time or a reviewed page at a time.

**Architecture:** Two Worker routes on `/people/:id` (list, guarded review write), a review page, one menu item.

**Tech Stack:** Hono, D1, zod/mini, React 19, Mantine, TanStack Query, vitest.

**Spec:** `docs/superpowers/specs/2026-11-27-confirm-auto-faces-design.md`

## Global Constraints

- No migration, no new index, no change to existing queries, matching, references or the agent.
- Page size 48. Body: 1 to 200 ids in total, disjoint. `zod/mini`. No `OFFSET`, no `COUNT`.
- Writes only touch faces that are `auto` for this person in an album the caller owns.
- One feature commit, with `README.md`, `AGENTS.md` and `docs/`. No em dashes. Do not merge the PR.
- Do not touch the running Drive indexer.

## Review Focus

1. A face moved, rejected, ignored, confirmed or deleted since the page loaded: skipped, never changed (Task 1).
2. Coming back to the tab after "Open photo": same page, same ticks, no refetch (Task 2).
3. A picture that fails to load: in neither list, buttons still usable (Task 2).
4. Tied scores across a page boundary: no face lost or repeated (Task 1).
5. A double click on a save button: one request (Task 2).

---

### Task 1: Worker routes

**Files:** Modify `worker/src/routes/people.ts`, `worker/src/index.ts`, `functions/api/[[path]].ts`,
`worker/test/sharing-writes.test.ts`, `worker/test/query-plans.test.ts`, `functions/api/proxy.test.ts`.
Create `worker/test/confirm-faces.test.ts`.

**Interfaces (produces):**
- `AUTO_PAGE_SIZE = 48`
- `autoFacesSql(after: boolean): string`, binds: email, email, personId, email, then (score, rowid) when `after`.
  An inner query walks `idx_faces_person_status_created` and sorts `(COALESCE(match_score,-1), rowid)`; the outer
  one reads details and names for the kept rows by rowid.
- `CONFIRM_AUTO_SQL`, `REJECT_AUTO_INSERT_SQL`, `REJECT_AUTO_SQL`, binds: JSON ids, personId, owner email
  (the insert binds personId first, for the inserted column). Guard: `id IN json_each` with `+person_id`,
  `+assign_status = 'auto'` and an `EXISTS` on the owned album.
- `GET /people/:id/auto-faces?cursor=<score>|<rowid>` returns `{ faces: SerializedFace[], nextCursor: string | null }`.
- `POST /people/:id/auto-faces/review` `{ confirm?: string[], reject?: string[] }` returns
  `{ confirmed: string[], rejected: string[] }`.

- [ ] **Step 1: Failing tests** in `confirm-faces.test.ts` (setup as `face-ignore.test.ts`):
  - list: only this person's auto faces in owned albums, ascending score; 100 faces with 3 distinct scores page
    as 48/48/4 with every id exactly once; malformed cursor 400; viewer 403; stranger 404.
  - review: confirm gives `confirmed`, null `match_score`; reject gives `unassigned`, null person, a
    `face_rejections` row; a face that is confirmed, auto for another person, unassigned, ignored, rejected,
    unknown or in an unowned album is not returned and its row and rejections are unchanged.
  - body: `{}`, both empty, 201 ids total, an id in both: 400, nothing changed.
  - a confirmed face is not moved by a later `POST /people/:other/match` with `apply`.
- [ ] **Step 2:** `cd worker && npx vitest run test/confirm-faces.test.ts`; expect 404 failures.
- [ ] **Step 3:** Implement `autoFacesRoute` and `reviewAutoFacesRoute` (`requirePersonOwner`, one `DB.batch` in
  the order confirm, rejection insert, reject, `RETURNING id`). Register with `app.get` and `guardedWrite`.
- [ ] **Step 4:** Add `GET` `^people\/[^/]+\/auto-faces$` and `POST` `.../auto-faces/review` to the proxy
  allowlist with proxy tests; add the write to `sharing-writes.test.ts`.
- [ ] **Step 5:** Pin plans: list (first and `after`) searches `idx_faces_person_status_created
  (person_id=? AND assign_status=?)`, no `SCAN f`; the three writes search faces by primary key, no `SCAN faces`.
- [ ] **Step 6:** `cd worker && npm test && npm run typecheck`, root proxy tests; all pass.

### Task 2: Client and review page

**Files:** Modify `src/services/api/WorkerApiClient.ts`, `src/types/api.ts`, `src/services/matchQueue.ts`,
`src/App.tsx`, `src/components/PersonPage.tsx`. Create `src/components/ReviewAutoFaces.tsx` and
`src/components/__tests__/ReviewAutoFaces.test.tsx`.

**Interfaces (produces):**
- `getAutoFaces(personId, cursor?): Promise<{ faces: SerializedFace[]; nextCursor: string | null }>`
- `reviewAutoFaces(personId, { confirm, reject }): Promise<{ confirmed: string[]; rejected: string[] }>`
- `refreshAfterReview(client)`: invalidates `photo-faces`, `people`, `album-contents`, `SEARCH_KEYS`.
- Route `/people/:id/review`; the person page links "Review auto matches" when `canEdit`.

- [ ] **Step 1: Failing tests:** all ticked; click unticks; buttons disabled until every picture settles;
  "Confirm 3" sends `reject: []`; "Confirm 2, mark 1 as Not A" sends both and calls `noteRemovedName` for each
  returned rejected id; "Mark 3 as Not A" when none ticked; a failed picture is in neither list; "Skip page"
  writes nothing and fetches `nextCursor`; saved/skipped message; "No more auto matches" and "Start again";
  failed save keeps ticks; double click sends once; focus event does not refetch; non-owner sees no faces and
  no request; "Open photo" has `target="_blank"`.
- [ ] **Step 2:** Run; fail. **Step 3:** Implement. Tile: `FaceTile` plus a hidden `<img>` of the same URL for
  load/error. Query `['auto-faces', id, round, cursor]`, `staleTime: Infinity`, `gcTime: 0`, no focus refetch.
- [ ] **Step 4:** `npm test`; pass.

### Task 3: Photo menu

**Files:** Modify `src/components/PersonPage.tsx` and its test.

- [ ] **Step 1: Failing tests:** "Confirm Asha" shows only with an auto face and `photo.canEdit`; calls
  `reviewAutoFaces('pe1', { confirm: [id], reject: [] })`; an empty `confirmed` shows "This face had changed,
  nothing was confirmed" and refreshes.
- [ ] **Step 2 to 4:** Fail, implement (`canConfirm` prop), pass.

### Task 4: Mock, measurement, docs, PR

- [ ] `dev/mockApi.ts`: both routes; check the page in a browser with `PIXDEX_MOCK=1 npm run dev`.
- [ ] Measure rows read and written on a local D1 (persons with 530 and 3,000 auto faces among ~8,500, plus
  confirmed, ignored and unnamed ones) with a throwaway test reading `meta.rows_read`; do not commit it.
- [ ] Update `README.md`, `AGENTS.md`, `docs/development.md` with behaviour and measured numbers.
- [ ] `npm test && npm run lint && npm run build`, worker tests and typecheck, `graphify update .` if it applies.
- [ ] Review the diff, commit once, push, `gh pr create`. Do not merge.
