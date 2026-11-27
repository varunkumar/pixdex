# Confirm auto-matched faces: design

Date: 2026-11-27. Status: awaiting approval.

## Intent

A person's owner can settle auto-matched faces by confirming them, so matching never checks or moves them
again. Today the only way is "Not A" followed by choosing A again, one face at a time.

## Goals

- "Confirm A" in a photo's menu on the person page, for auto matches.
- A "Review auto matches" view: pages of face crops, untick the wrong ones, confirm the rest.
- Unticked faces: the owner chooses each time between leaving them auto and marking them "Not A".
- A stale page never takes a face back.

## Non-goals and anti-goals

- No confirm of faces not shown (no "Confirm all").
- No change to how references are chosen, to matching, to rescans or to the agent.
- Viewers see none of it. Only faces in albums the caller owns.
- Do not touch the running Drive indexer.

## Approaches (review order)

1. **Weakest match first, no migration (chosen).** Likely mistakes come first. Each page reads and sorts all of
   the person's auto faces: estimated 3 x N rows (about 1.6K at 530, 9K at 3,000).
2. Newest scanned first, served by `idx_faces_person_status_created`: flat and cheapest, mistakes scattered.
3. Weakest first with a new partial index: flat, but a migration, writes during matching and a risk to other
   plans. Can be added later without a UI change if approach 1 measures badly.

## Worker

Both routes require the caller to own the person (404 not visible, 403 not theirs), are in the Pages proxy
allowlist, and use `zod/mini`.

`GET /people/:id/auto-faces?cursor=`

- The person's `auto` faces in albums the caller owns, ordered by (`match_score`, rowid) ascending, 48 per
  page. Keyset cursor `<score>|<rowid>`, no `OFFSET`, no `COUNT`. 400 for a malformed cursor.
- Returns `{ faces, nextCursor }`. The inner query sorts ids only; face details and names are read for the 48
  kept rows.

`POST /people/:id/auto-faces/review`, registered with `guardedWrite`

- Body `{ confirm: ids, reject: ids }`: 1 to 200 ids in total, no id in both, else 400.
- Every statement is guarded, at write time, by `person_id = :id AND assign_status = 'auto'` and the face's
  album being the caller's. Anything else (moved, rejected, ignored, already confirmed, deleted by a rescan,
  not owned) is skipped, not an error. An ignored face is `unassigned`, so the guard excludes it.
- Confirm sets `assign_status = 'confirmed'`, `match_score = NULL`. It does not touch `ignored_at` or
  rejections (`confirmFacesStmts` is not reused, it is unconditional).
- Reject adds the `face_rejections` row and unassigns, the same effect as "Not A".
- One batch of set-based statements. Returns `{ confirmed: ids, rejected: ids }`, the ids actually changed.

## Frontend

**Review view**, route `/people/:id/review`, opened by "Review auto matches" on the person page (owner only).

- One page of 48 crops, all ticked. Clicking a crop toggles it. Each tile has an "Open photo" link that opens
  in a new tab, so ticks are kept.
- Buttons act only on the shown page: "Confirm N" (leaves unticked faces auto), and, when some are unticked,
  "Confirm N, mark M as Not A" ("Mark M as Not A" when N is 0). "Skip page" moves on without writing.
- The buttons wait until every picture on the page has loaded or failed. A face whose picture failed says so
  and is sent in neither list, so nothing unseen is changed.
- After a save: say how many were confirmed, rejected and skipped as changed; refresh people, photo faces and
  searches; load the next page from the current cursor. At the end: "No more auto matches", with "Start again"
  (skipped and unticked faces are still auto).
- A failed save keeps the page and ticks and shows the error.

**Photo menu:** "Confirm A" beside "Not A", when the caller owns both the person and the photo's album. It acts
on the same face as "Not A", through the review route. If the face had changed, say so and refresh.

**Removed name:** each id returned in `rejected` goes to `noteRemovedName`, as "Not A" does today, so naming
it B later also re-checks A's auto faces.

**Matching:** confirming does not start a match run. "Re-run matching" is there when wanted.

`dev/mockApi.ts` serves both routes.

## Effect on matching quality

References are the 30 confirmed faces newest by scan time (`faces.created_at`), and a face scores against its
best single reference.

- Under 30 confirmed: confirming adds references, so recall should rise.
- 30 or more: confirmed faces with later scan times displace older references, possibly hand-picked ones, and
  the new set may be near-duplicates from one shoot, which can lower recall on other looks.
- A wrongly confirmed face that becomes a reference attracts similar wrong faces, including other people's
  auto faces on a higher score. "Not A" on its photo undoes it.
- Confirmed faces also leave the candidate set, and the biggest confirmed face is the default cover when no
  cover was picked, so a default cover may change.

Not measured. Choosing references differently is a separate change.

## Cost (to measure before the PR)

- List: `personRole`, then one statement, about 3 x N rows read, 0 written. Worst case (3,000 faces, 63 pages)
  about 570K rows read for a full review.
- Review: `personRole` plus at most 3 set-based statements over at most 200 primary-key lookups; writes only
  changed faces (with their index entries) and one rejection per rejected face. At most 48 from the UI.
- Pictures: up to 48 crop requests per page (each a Function and Worker call, D1 key reads and one R2 get),
  cached by the browser for a day. A face with no crop uses the photo thumbnail.
- Worker CPU: mapping 48 rows; no embeddings are read.
- Measure on a local D1 with realistic counts, pin both plans in `worker/test/query-plans.test.ts` (no scan of
  `faces`), and after deploy check `wrangler tail` and `wrangler d1 insights`.
- No migration and no new index.

## Tests

Worker: ownership (404, 403, another owner's album), each stale case is skipped, rejection recorded, order and
cursor, body validation, plans, proxy allowlist. Frontend: ticks and both buttons, unloaded or failed
pictures, skip and paging, menu item gating, `noteRemovedName`, viewer sees nothing.

## Docs

`README.md`, `AGENTS.md` and `docs/` in the same commit.

## Left to the builder

Component split, query text, exact wording of messages.
