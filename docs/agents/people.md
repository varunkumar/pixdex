# People, faces and matching

Agent notes. Read this file before you change this area. Update it with each change.
The core rules are in [`AGENTS.md`](../../AGENTS.md). Paths are relative to the repository root.

- Ignored faces (migration `0021_face_ignore.sql`, `faces.ignored_at`, NULL = not ignored). An ignored face is always `unassigned`
  with no person. Only the album owner ignores or restores: `POST /faces/ignore` and `/faces/restore` (`{ faceIds }`, 1 to 200,
  `guardedWrite`, all-or-nothing 404/403, set-based; ignore skips faces that are not unassigned; `{ ignored }` / `{ restored }` counts)
  and `GET /people/ignored?cursor=` (owned albums only, newest first, 60 per page, cursor `<ignored_at>|<rowid>`, 400 if malformed);
  all three are in the proxy allowlist. Every new face query must skip ignored faces where it would group, match or show a
  known-personality match: groups, match candidates and apply, auto-match, `knownFilterSql`, `KNOWN_COUNTS_SQL`, album known tiles
  and covers (shared viewers lose the match too; `known_id` is kept so restore brings it back). Confirming a face clears
  `ignored_at`. A rescan keeps an ignored face like a confirmed one (overlapping new face dropped, counted in `kept`, crop and
  rejections stay). Agent and ingest bodies never set it. `SerializedFace.ignored`. UI: "Ignore group" and a cross per face on the
  People page, `IgnoredFaces.tsx` (closed by default, no request until opened), "Ignore" / "Restore" on the photo's People card
  (owner only). On the photo page the owner has two dimmed links, "Other faces (N)" (unnamed and not matchable) and
  "Ignored faces (N)"; those faces are numbered after the others and their boxes show only while their section is open
  (`splitFaces`, `src/services/faces.ts`, which mirrors `MIN_DET_SCORE` and `MIN_FACE_SIDE` from `worker/src/people/matching.ts`:
  change both together; viewers see every face). Not covered: no negative references, so new photos of the same stranger appear as new unnamed faces.
  **Index rules (measured, do not change casually):** the migration is additive. `idx_faces_assign_status` and
  `idx_faces_known_photo` stay as they were: replacing the status index was measured to slow existing queries (the people cover
  query about 29% more rows read; with a widened index the old groups query about 240 times more). The partial indexes
  `idx_faces_ignored`, `idx_faces_open_status` and `idx_faces_known_shown` are for the new queries only: groups and the known
  list and filter pin theirs with `INDEXED BY`, and every other `ignored_at` test is written `+ignored_at` so a partial index
  cannot take over its plan.
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
- Background matching (frontend): naming a face or group, and Re-run matching, only enqueue the person in
  `matchQueueFor(queryClient)` (`src/services/matchQueue.ts`; the hook `src/hooks/useMatchQueue.ts` is only for components that show its state); never await `matchPersonAll`
  in a component. One person runs at a time, a person already waiting is not queued twice, progress is `MatchStatus` in `Layout`
  (with a `beforeunload` warning). After a save, `refreshAfterNaming` drops the named faces from the cached groups (no group
  refetch) and refreshes the other lists; a finished run refreshes everything only if it matched something or failed.
- What a match run checks: `POST /people/:id/match` without `from` checks unnamed faces and other people's auto faces
  (Re-run matching, Review suggestions). With `from` (at most 50 person ids, usually empty) it checks unnamed faces, then
  the auto faces of those people, in two phases (`MATCH_UNNAMED_SQL`, then `MATCH_MOVED_SQL` with cursor `m<rowid>`). The
  automatic run after naming always sends `from`: callers use `matchAfterNaming` and record "Not X" / "Remove name" with
  `noteRemovedName` (both in `matchQueue.ts`; browser memory only). Do not merge the two phases into one query: it re-walked
  every unnamed face on every page (measured 70K rows read for a correction against about 16K). Measured on a local D1 with
  715 confirmed, 8,461 auto, 5,503 ignored and 10,779 unnamed non-matchable faces across 16 people: full run 80 requests and
  about 41K rows read; naming an unnamed face 1 request, about 11K; a correction from a person with 529 auto faces 7 requests,
  about 16K. 0 extra writes, no migration, same 100-face CPU cap per request. The phase 2 reads grow with the previous
  person's auto faces (each page walks their index entries), and phase 1 still walks unnamed faces too small to match.
- Match page query (`MATCH_CANDIDATES_SQL`, `worker/src/routes/people.ts`): keep the unary `+` on `assign_status` and the
  CROSS JOINs. It must walk `faces` by rowid and stop at `FACE_PAGE_SIZE` (plan pinned in `worker/test/query-plans.test.ts`);
  through the status index every page read and sorted all remaining candidates.
- Confirming auto matches (person owner only, faces in albums they own; no migration, no new index):
  `GET /people/:id/auto-faces?cursor=` lists that person's `auto` faces weakest match first (`autoFacesSql`, 48 per page,
  keyset cursor `<score>|<rowid>`, 400 if malformed; `{ faces, nextCursor }`). `POST /people/:id/auto-faces/review`
  (`{ confirm?, reject? }`, 1 to 200 ids in total, disjoint; `guardedWrite`) returns `{ confirmed, rejected }`, the ids
  actually changed. Binding rule: every statement re-checks at write time that the face is still `auto` for this person in
  an owned album (`REVIEWABLE_SQL`), so a stale page never takes back a moved, rejected, ignored, confirmed or deleted
  face; do not use `confirmFacesStmts` for this (it is unconditional and clears ignores and rejections). Never add a
  "confirm all" over faces that were not shown. UI: "Review auto matches" on the person page (`/people/:id/review`,
  `ReviewAutoFaces.tsx`: all ticked, buttons act on the shown page only and wait for every picture; a failed picture is in
  neither list; "Skip page"; the page query never refetches under the ticks; "Open photo" opens a new tab), and "Confirm X"
  beside "Not X" in the photo menu (needs `canEdit` on both the person and the photo). Rejected ids go to
  `noteRemovedName`. Confirming starts no match run.
  "To review" (`/review`, `ReviewQueue.tsx`; People page link "N matches to review"; "← To review" and "Next: ..." on
  the review grid) lists the caller's people with `auto` faces in owned albums, from `GET /people/review-queue`
  (`{ people: [{ id, count }] }`, most first, `REVIEW_QUEUE_SQL`; names and covers come from `GET /people`). It reads
  about 5 rows per pending face (2,671 at 530; 14,898 at 3,000; 42,123 at 8,500; local D1), so it is requested only by
  those screens (query key `['review-queue']`, 5 minute staleTime). Binding rule: a change to auto faces calls
  `markReviewQueueStale` (`refetchType: 'none'`), never an immediate refetch, and no navigation badge or other page may
  request it. "Next" skips people already finished in this visit (`services/reviewVisit.ts`, browser memory).
  Performance (local D1): the list reads about 5 rows per auto face of the
  person on every page (first page 2.8K rows at 530 faces, 15K at 3,000; paging through 3,000 without changes 577K); a
  review of 48 reads 432 to 672 rows and writes 192 to 336; no embeddings read, at most 48 rows mapped in the Worker.
- Person page faces: the page sends one `GET /people/:id/faces?photos=` for each page of photos (1 to 48 ids).
  - It sends the request for a person that the user created. For any other person, it sends it only on the Faces tab.
    The query key is `['person-faces', personId, photoIds]`.
  - While the next answer loads, the last answer for the same person stays. A face controls only the tile of its photo.
  - Invalidate `person-faces` each time that you invalidate `photo-faces`.
  - `personPhotoFacesSql` starts from the photo ids (`idx_faces_photo_id`). Keep the unary `+` on person and status.
    `query-plans.test.ts` pins this plan.
  - The route does no role check. A person or photo that is unknown or invisible matches nothing.
  - Performance (local D1, 48 photos with 3 faces each): 1 statement reads 336 rows and writes 0.
    Before, 48 requests ran 96 statements and read 527 rows.
  - Faces tab, viewer of a shared album (local D1, 48 photos with 3 auto faces each, one album, no viewer labels):
    1 statement reads 432 rows and writes 0. The owner reads the same in that setup. Viewer labels were not measured.
- Matching references (migration `0023_person_references.sql`, table `person_references (person_id, face_id)` plus
  `idx_person_references_face`): up to 30 confirmed faces per person, chosen by `worker/src/people/referenceSelection.ts`
  (bucket by photo year, undated is a bucket; rank by box area, then `det_score`, then rowid; take turns across buckets).
  The migration's backfill repeats the rule: change both together (`PERSON_REFERENCES_BACKFILL_SQL`, compared by a test).
  Binding rule: every new write that changes confirmed faces calls `refreshReferences` after it commits, with the persons
  that gained a face and the face ids that may have left one; deleting a person deletes their rows. It never throws, is
  also run by the first page of Re-run matching (`apply`, no `from`, no cursor), and `loadReferences` ignores rows whose
  face is no longer confirmed for the person. Never choose references at load time. Tests: a fixture trigger
  (`REFERENCE_FIXTURE_SQL`) makes directly inserted confirmed faces references. Performance (local D1): loading reads
  about 3 rows per reference (1,099 for 356 references across 16 people), CPU unchanged (at most 30 embeddings per
  person); a refresh reads about 8 rows per confirmed face of the affected people (954 at 116, 4,266 at 530, 24,026 at
  3,000), about 7 when nobody is affected, and writes only changed rows (3 to 60); migration backfill of 716 confirmed
  faces 6,012 read, 712 written. Matching quality before and after is unmeasured.
