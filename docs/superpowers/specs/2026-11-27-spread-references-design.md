# Reference faces spread across years: design

Date: 2026-11-27. Status: awaiting approval.

## Intent

A person's photos span many ages. Matching uses only 30 confirmed faces, today the 30 scanned most recently, so
whole periods can drop out. Choose the 30 to cover the years the person was photographed in.

## What the library shows (read-only count on live D1, 2026-11-27)

716 confirmed faces, 16 people. 11 people have more than 30, so they lose references today. Dated years run
2008 to 2026, up to about 12 per person. 74 faces have no date. Scanned prints carry their scan date.

## Goals and non-goals

- Each year with confirmed faces gets references; within a year the best faces are used.
- Matching reads about as much as today.
- No pinning of faces (can be added later if a childhood period is still missed).
- No change to thresholds, match queries, the agent, or any existing auto or confirmed face. No change to the
  running Drive indexer.

## Selection rule

Over a person's confirmed faces: bucket by the photo's year (`date_time`; no date is one bucket of its own).
Rank within a bucket by face box area (share of the frame), then detection score, then rowid. Take every bucket's
best, then every bucket's second, and so on, until 30. With 30 or fewer confirmed faces, all are references.
Box area is only a stand-in for quality: blur is not recorded.

## Approaches

1. **Store the choice, recompute when confirmed faces change (chosen).** Matching reads at most 30 per person.
2. Choose at every load. No migration, but each load reads every confirmed face, and ingest loads up to once a
   minute: too costly on D1's free plan after bulk confirming.
3. The agent chooses by appearance. Covers undated scans, but favours oddities and is more to build.

## Data

Migration `0023_person_references.sql`, additive: table `person_references (person_id, face_id)`, primary key on
both, `WITHOUT ROWID`. No change to `faces` or its indexes. The migration fills it for existing people with the
same rule.

## Behaviour

- One set-based recompute (parameter: JSON person ids) that removes rows no longer chosen and inserts new ones,
  so an unchanged choice writes nothing.
- It runs in the same batch as every write that changes confirmed faces: naming (create person, assign one or
  many, including the person a face is taken from), "Not X", "Remove name", and a review that confirms.
  Deleting a person deletes their rows.
- "Re-run matching" recomputes that person first, which repairs anything missed.
- `loadReferences` reads the table and still requires the face to be confirmed for that person, so a stale row
  is ignored, never used.
- Not triggered by a photo date changing at re-index; the next change or re-run picks it up.
- Confirmations made by the old Worker between the migration and the deploy are picked up the same way.
- The ingest cache (60 s) is unchanged.

## Cost (estimates, to measure before the PR)

- Matching and ingest: about 3 rows read per reference (table, face, no extra person work), at most 30 per person.
- Recompute: about 4 rows read per confirmed face of the affected person (about 500 at 116 faces, 12K at
  3,000). Writes only the rows that change. A review of a 3,000-face person confirming page by page adds roughly
  as many reads again as the review itself, at worst about 400K over 63 saves.
- Worker CPU: unchanged; at most 30 embeddings per person are decoded, and the selection runs inside D1.
- Plans pinned in `worker/test/query-plans.test.ts`, with no scan of `faces`.

## Limits

Coverage follows dates: ages scanned in the same year share that year's turns (about 2 to 3 places each for a
person with 12 years). Whether matching improves is not measured; young children's references may attract other
children.

## Tests

Rule (spread, ranking, undated, 30 or fewer), every triggering write, stale rows ignored, backfill equals the
recompute, unchanged choice writes nothing, plans.

## Docs

`README.md`, `AGENTS.md` and `docs/` in the same commit.
