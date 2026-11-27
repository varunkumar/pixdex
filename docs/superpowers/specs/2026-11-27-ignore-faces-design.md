# Ignore faces: design

Date: 2026-11-27. Status: awaiting approval.

## Intent

Strangers and background people clutter the unnamed groups on the People page. The album owner can
ignore a face (or a whole group), it stops showing up and being matched, and they can undo it.

## Goals

- Ignore one face or a whole shown group from the People page; ignore one face from the photo page.
- Ignored faces are left out of unnamed groups, ingest auto-match, `POST /people/:id/match` and references.
- Ignoring also hides the face's known-personality match ("looks like"). The match stays stored.
- See ignored faces and restore them.
- A rescan keeps a face ignored.
- Only the album owner can ignore or restore. Agent and ingest bodies cannot set it.

## Non-goals

- Ignoring a *person*: a new photo of the same stranger still appears as a new unnamed face. No negative
  references.
- Ignoring every look-alike. "Ignore group" covers the faces in that group card only; groups are clustered
  per page of 50 faces, so the same stranger can have more than one card.
- Any agent change, or touching the running Drive indexer.

## Approaches

1. **Nullable `faces.ignored_at` (chosen).** One additive column, a filter in each query that must skip
   ignored faces. Risk: a missed query, covered by one test per path.
2. Side table `face_ignores`. `faces` untouched, but every candidate needs a probe, groups still read
   ignored rows, and a rescan must carry each ignore to a new row (lost if the new scan misses the face).
3. New `assign_status` value. Needs a rebuild of `faces` because of its CHECK constraint: destructive, on a
   table the indexer writes. Rejected.

## Data

Migration `0021_face_ignore.sql` (mirrored in `worker/migrations/index.ts`):

- `ALTER TABLE faces ADD COLUMN ignored_at TEXT;` (NULL means not ignored)
- `idx_faces_ignored ON faces (ignored_at) WHERE ignored_at IS NOT NULL` (the ignored list)
- Replace `idx_faces_assign_status` with
  `idx_faces_open_status ON faces (assign_status) WHERE ignored_at IS NULL`
- Replace `idx_faces_known_photo` with
  `idx_faces_known_shown ON faces (known_id, photo_id) WHERE known_id IS NOT NULL AND ignored_at IS NULL`
  (add `ignored_at` as a trailing column if the plan test shows the known list is no longer covering)

The two indexes are replaced, not added beside the old ones, so a face insert writes the same number of rows
as today. No data is lost. Between the migration and the Worker deploy (seconds), the old known-list and
known-filter queries have no matching index and scan `faces`. A rolled-back Worker would stay in that state
until the old index is recreated.

Invariant: `ignored_at IS NOT NULL` implies `assign_status = 'unassigned'` and `person_id IS NULL`.

## Worker

| Route | Behaviour |
|---|---|
| `POST /faces/ignore` `{ faceIds }` (1 to 200) | Owner of every face's album, else 404/403 for the whole request. One set-based UPDATE of the faces that are unassigned and not yet ignored. `auto` and `confirmed` faces are skipped. Returns `{ ignored: n }`. |
| `POST /faces/restore` `{ faceIds }` (1 to 200) | Same gate. Clears `ignored_at`. Returns `{ restored: n }`. |
| `GET /people/ignored?cursor=` | Ignored faces in albums the caller owns, newest first, 60 per page, keyset cursor on `(ignored_at, rowid)`. Returns `{ faces, nextCursor }`. Bad cursor is a 400. |

Both writes use `guardedWrite`, zod/mini, and join the Pages proxy POST allowlist; the list joins the read
allowlist. A single face is a list of one. Face rejections are left as they are.

Changes to existing paths (`ignored_at IS NULL` unless noted):

- `groupsRoute`, `MATCH_CANDIDATES_SQL` and its apply UPDATE, `autoMatchFaces` select and update.
- `confirmFacesStmts` sets `ignored_at = NULL`: explicitly naming a face wins.
- `ingest-faces.ts`: an ignored face is kept like a confirmed one. The delete, stale-crop and rejection
  statements exclude it, and a new face overlapping it (IoU >= 0.5) is dropped and counted in `kept`; its
  id is returned in `faceIds`, so the agent can refresh its crop. A kept face keeps its own `known_id`.
- Known paths: `knownFilterSql` (search, timeline, timeline buckets), `KNOWN_COUNTS_SQL`,
  `KNOWN_COUNTS_ALBUM_SQL`, `KNOWN_COVERS_SQL`. This hides the match from shared viewers too.
- `SerializedFace` gains `ignored: boolean`.
- References and people lists need no change: they read only confirmed or auto faces.

## Frontend

- Group card: "Ignore group" button, and a small ignore control on each shown tile
  ("Ignore face N of M"). No confirm dialog, because it is reversible. Ignored faces are removed from the
  cached groups without refetching every group page.
- Bottom of the People page: "Ignored faces", closed by default (no request until opened), a grid with
  "Restore" per face, "Restore all shown" (sent in batches of 200), and "Load more".
- Photo page, owner only: "Ignore" on an unnamed face; an ignored face shows "Ignored" and "Restore" only.
  An auto match is first removed with "Not X". Viewers see no change.
- Invalidate: ignored list, photo faces, known people, album contents, search keys.
- `dev/mockApi.ts` gets sample groups and the three routes.

## Worker CPU and D1

CPU: no new loops over embeddings or large payloads; the new routes handle at most 200 ids.

| Request | Statements | Rows read | Rows written |
|---|---|---|---|
| ignore / restore | 2 | up to about 4 per face (ownership joins, update), 800 at 200 faces | the face row plus changed index entries, about 4 per face |
| ignored list | 2 | owns-an-album probe, then about 4 per listed face, plus 1 to 3 per ignored face of other owners walked past | 0 |
| groups | unchanged | ignored faces cost nothing (not in the partial index) | 0 |
| match page | unchanged | ignored unassigned faces are still walked in the rowid scan and filtered, as today | unchanged |
| ingest faces | unchanged | unchanged | unchanged per face |
| auto-match, known list, known filter | unchanged | unchanged or lower | unchanged |

One-off: the migration builds two indexes, writing about one row per non-ignored and per known-matched face.
`EXPLAIN QUERY PLAN` tests cover groups, the ignored list, the known queries and the match page. Real D1
costs are unmeasured locally: check `wrangler d1 insights` and `wrangler tail` after deploy.

## Tests and docs

Worker tests: each excluded path, rescan keeps ignored (with rejections and crops), ownership (404/403),
naming clears the flag, ingest body cannot set it, ignored list paging, query plans. Proxy allowlist and
frontend component tests. README.md, AGENTS.md and docs/ in the same PR. The PR is not merged here: merging
deploys the Worker the indexer calls (ingest request bodies are unchanged).
