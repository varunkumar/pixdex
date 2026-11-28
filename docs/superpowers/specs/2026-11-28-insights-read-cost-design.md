# Design: lower the D1 reads of the dashboard

Status: approved on 2026-11-28.

Changed during the work: Gear cannot reach 110,000 rows without more Worker CPU. Its cache has two parts (`gear` and
`gear-recipe`) that refresh on different days. So six cycles start 5 days apart, not five cycles 6 days apart.

## Intent

The dashboard reads too much from D1. A first visit of a day reads 447,641 rows, about 9% of the free daily limit,
for each user. The cost grows as indexing adds photos. The facts describe years of photos, so they can change slowly.

## Measured today (live data, 2026-11-28, 15,768 photos)

| Topic | Rows read |
|---|---|
| Gear (5 queries) | 218,126 |
| People (2) | 97,747 |
| Wildlife (2) | 44,281 |
| Places (2) | 36,504 |
| Time (1) | 31,938 |
| On this day (1) | 19,045 |
| Total | 447,641 |

CPU on one first visit: Gear 10 ms (the free limit), On this day 8 ms, other topics 4 to 5 ms.

## Approaches

- **A. Refresh slowly.** Smallest change. About 17,000 rows per day on average, about 237,000 on the worst day.
- **B. A, plus cheaper queries.** About 11,000 on average, about 130,000 on the worst day. **Chosen.**
- **C. Summary tables kept by triggers.** Facts stay fresh, but it needs new tables, a backfill and more writes during
  indexing. People, burst and "On this day" do not fit. It is much more work.

All numbers for A, B and C are estimates.

## Design

### Tile topics: refresh every 30 days

- Each topic has a 30-day cycle in India days. The cycles start 6 days apart: Time, Gear, Wildlife, People, Places.
- A cached topic is valid until its next cycle starts. The first visit after that calculates it again.
- A topic with no facts is valid for one day only. A new library then shows facts without a month of delay.
- A change of `INSIGHTS_VERSION` recalculates all topics, as today.
- Person names are still resolved on each read.

### On this day: one query for seven days

- One calculation prepares the results for a block of 7 days.
- The photos still change each day. Each date shows the same selection as today: 12 photos per year at most.
- Each read still loads the photos by id and checks the owner.

### Cheaper queries

- Gear reads the owner's photos in fewer passes. Target: 110,000 rows or less.
- People reads the named faces in fewer passes, or with a shorter path. Target: 75,000 rows or less.
- A full calculation of all topics: 300,000 rows or less.
- No fact changes its meaning. The existing tests for each fact stay as they are.
- Read isolation stays: queries start from the caller's albums or persons.
- Gear CPU must not go up.

## Goals

- Average: about 11,000 rows per user per day.
- Worst day for a regular visitor: about 130,000 rows.

## Non-goals

- Summary tables, new indexes, or changes to indexing.
- The face queries of the People pages.
- Changes to the look of the dashboard.

## Limits that stay

- A new user, or a user who returns after a month, calculates all topics in one visit.
- Tiles can be up to 30 days old. New photos can take up to 7 days to show in "On this day".

## Checks

- Tests for the refresh cycle, the empty result, and the seven-day block.
- `insights-cost.test.ts` sets limits for each topic. `insights-isolation.test.ts` still passes.
- Before the pull request: measure the live rows with the read-only script, if the owner agrees.

## Left to the builder

How to combine the queries, and the shape of the cached "On this day" data.
