# "To review" page for pending auto matches: design

Date: 2026-11-27. Status: awaiting approval.

## Intent

See which people have auto matches waiting for confirmation, in one place, and work through them without opening
each person.

## Approaches

- **A. One "To review" page (chosen).** A list of people with pending counts, leading into the existing review grid.
- B. Counts on the People cards with a sort. Smallest, but still means hunting and going in and out, and adds reads
  to the people list, which Search and Timeline also load.
- C. One mixed grid across people. No switching, but wrong faces are much harder to spot.

## Behaviour

- The People page shows "N matches to review" above the people, linking to `/review`. Nothing is shown when N is 0,
  while loading, or if the request fails.
- `/review` ("To review") lists the people with pending matches, most first (ties by name): cover face, name,
  "180 to review", "Review". With none: "Nothing to review."
- "Review" opens the existing `/people/:id/review` grid, unchanged in how it shows, confirms and rejects.
- On that grid, a link "All to review" goes back to `/review`. When the person's pages are finished it also offers
  "Next: <name> (<count>)": the person with the most pending, leaving out the current one and any whose review was
  finished earlier in this visit (so skipped pages do not send you round in circles). With nobody left, only the
  link back.
- Pending means a face with status `auto`, for a person you own, in an album you own. Unnamed groups are not
  included. Viewers see none of it.

## Worker

- `GET /people/review-queue` returns `{ people: [{ id, count }] }`, most first. Read token and viewer email, added
  to the Pages proxy GET allowlist. Names and covers come from the already loaded people list.
- One grouped statement: the caller's persons, then their auto faces on `idx_faces_person_status_created`, with
  photo and album key lookups. Plan pinned in `worker/test/query-plans.test.ts`.
- No migration, no new index, no writes.

## Cost

- D1: estimated 3 to 5 rows read per pending face (about 30K to 40K at 8,000 pending), to be measured and recorded
  in `docs/development.md`. Requested by the People page, `/review` and the end of a review; cached 5 minutes and
  refreshed after a review, naming or a match run. Search, Timeline and other pages do not request it.
- Worker CPU: maps at most one row per person.

## Not included

A navigation badge, a mixed grid, bulk confirm without looking, and any change to matching or the agent.

## Tests and docs

Worker (ownership, counts, order, plan, proxy allowlist) and frontend (People link, list, next person). Mock API,
`README.md`, `AGENTS.md` and `docs/` in the same commit.
