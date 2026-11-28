# Dashboard insights and "On this day"

Agent notes. Read this file before you change this area. Update it with each change.
The core rules are in [`AGENTS.md`](../../AGENTS.md). Paths are relative to the repository root.

## Routes

- `GET /insights/:topic` returns `{ day, facts }`. `BUILDERS` in `worker/src/routes/insights.ts` lists the topics. An
  unknown topic gives 404.
- `GET /insights/on-this-day?date=YYYY-MM-DD` returns `{ date, years: [{ year, photos }] }`. The date must be within
  two days of the India date, else 400.
- `POST /insights/refresh` (body `{}`) deletes the caller's cached rows that are older than 5 minutes and returns
  `{ removed }`. The next reads calculate them again. It writes only the caller's rows, so any viewer may call it.
- All use `requireReadToken` and are in the proxy allowlist. The POST is in the write allowlist.

## Rules

- **Scope:** only albums that the caller owns (`ownedSql`). Shared albums never count.
- **Read isolation:** a topic reads only the caller's photos, through the album or person indexes. Do not add `+` to
  the album column of a topic query. `worker/test/insights-isolation.test.ts` adds a second user and fails on a changed
  answer, a table scan or more rows read. "On this day" starts from the caller's albums for the same reason: do not
  drive it from `idx_photos_date_time`, which reads every user's photos of those dates.
- **Camera time:** `date_time` is the camera clock read as India time and saved as UTC. Add
  `CAMERA_OFFSET_MINUTES` (330) before you group by day, weekday or hour. `datedCte` does this and drops junk dates
  (before 1990, after tomorrow, or not readable).
- The Timeline and the `onThisDay` search still group by the stored value. This is a known problem.
- **Cache:** `insights_cache` (migration `0024`) has one row for each user and cached part. A row is valid for one
  `day` key and one `INSIGHTS_VERSION`. Raise the version when a definition or a cached shape changes. The GET writes
  only the caller's own rows.
- **Refresh:** a tile part is calculated once in a 30-day cycle (`periodStart`). The offsets in
  `routes/insights.ts` are 5 days apart: time 0, gear 5, wildlife 10, people 15, places 20, gear recipe 25. Keep them
  apart, so that a regular visitor calculates one part in a visit.
- An empty answer is stored as `empty:<day>` and is valid for that day only. The `gear-recipe` row (no route of its
  own) uses this when there are too few photos for any recipe.
- The cache holds ids and numbers, never photo rows or names. Each read loads them again and checks ownership. A new
  share or owner edit shows in the facts at the next refresh. A deleted person, and a deleted photo in
  "On this day", drop out at once. Counts and place names in the tiles stay until the next refresh.
- "On this day": one window of date ±2 days for each year from 1990, 12 photos for each year by combined score.
  29 February counts as 28 February. One calculation covers a 7-day block (`blockStart`): `ON_THIS_DAY_SQL` gives the
  12 best photos of each camera day, and the Worker gives them to the seven dates. The statement must search the
  `(album, date_time)` index for each owned album and range (pinned in `worker/test/query-plans.test.ts`).
- Do not make date texts for each year and date in "On this day": that used about 2,000 date operations. The query
  needs two texts for each earlier year and calendar year of the block (`blockRanges`). The Worker matches rows by
  day number (`dayNumber`). A test limits the number of date texts.

## Topics

A fact below its minimum is not returned. Definitions and minimums are in the code of each builder.

- `time` (`insights/time.ts`, 1 statement that returns the shooting days): `top-month`, `top-weekday` (100 dated photos), `records` (10 shooting
  days), `shifts` (4 years of 100 photos; the newer half takes the extra year; absent when the peak month is equal).

- `gear` (`insights/gear.ts`, 3 statements: one grouped by lens, camera and year, one for the zoom bins, and the
  recipe in its own cache part): `top-lens` (20 hits), `hit-rate` (2 lenses of 50, top 4), `recipe`
  (weekday, 2-hour slot and focal group of 50, above the average), `zoom` (most used lens with max >= 1.5 x min and 100
  photos), `burst` (a new moment after 2 s for each camera; 2 years of 100), `progress` (2 years of 100; the camera is
  context, not a cause), `cameras` (2 with 20 photos, top 6). A hit is a combined score of `HIT_SCORE` (7) or more (16% of the
  live library on 2026-11-28; change the "7+" text in `factText.ts` with it).

- `wildlife` (`insights/wildlife.ts`, 1 statement): `life-list` (5 species; the year is the current one if it added a
  species, else the year before), `best-chance` (30 photos of the most photographed species; the slot is within its
  busiest month). Bad `species` text counts as none.

- `people` (`insights/people.ts`, 1 statement that returns at most 4 rows): `together` (top 3 pairs with 10 shared photos), `missed` (20
  photos, last one over 365 days ago, the oldest). Only the caller's own people; auto and confirmed faces; never
  ignored ones. The cache holds person ids. `hydrateFacts` resolves names with `PERSON_NAME_SQL` on each read and
  drops deleted people. `PEOPLE_SQL` starts from the caller's persons (plan pinned). It groups pairs and people in
  SQL, from one materialized row for each set of people. Do not move this grouping to the Worker (CPU).

- `places` (`insights/places.ts`, 1 statement): `travel` (100 photos with GPS; from the 0.1 degree cell with the most
  days to the farthest cell), `places` (20 photos with a place; places new in the current year, else the year before;
  top 3 by days). Dated photos only. GPS 0,0 is skipped. Place names come from the agent (`photos.place`).

## Cost

- One pass over the photos without a sort reads about 1 row for each photo. A `GROUP BY` reads 2. The burst window
  reads 5. Give each topic as few statements as possible. A `MATERIALIZED` CTE with a row for each photo, grouped
  twice, costs more than two statements. A small one (People: one row for each set of people) does not.
- Live, before the 30-day cycle (2026-11-28, 15,768 photos): 447,641 rows for every visit of a new day. Gear 218,126,
  People 97,747, Wildlife 44,281, Places 36,504, Time 31,938, "On this day" 19,045. CPU on one visit: Gear 10 ms,
  "On this day" 8 ms, other topics 4 to 5 ms.
- Plan: on 2026-11-28 the account used the Workers Paid plan. The free limits (10 ms CPU, 5M rows read each day)
  apply if it returns to the free plan.
- Local D1 now (`worker/test/insights-cost.test.ts`, 2,000 photos, 500 faces): all parts together read 31,225 rows
  (before: 51,422). Gear 18,181 (31,029), Time 4,059, Wildlife 2,859 (5,326), People 1,543 (4,326), Places 2,282
  (4,569). The test holds a limit for each topic.
- Live, one calculation of every part (2026-11-28, 15,796 photos, `wrangler d1 execute`): 269,035 rows. Gear
  143,851 (main 95,591, zoom 16,572, recipe 31,688), Time 31,992, People 31,194, Wildlife 23,734, "On this day"
  20,008 (one week), Places 18,256.
- These live rows are from before the People CPU fix. People now reads more rows: about 37,000 live, estimated, so
  about 275,000 for all parts.
- Derived from the live rows, for each user: about 11,200 rows for each day on average, about 112,000 on the Gear
  day (about 132,000 when that day also starts an "On this day" block).
- A refresh calculates every part in one visit (about 275,000 rows, estimated). The 5-minute limit stops repeated
  clicks. Gear then calculates both parts in one request.
- A cached full visit reads 266 rows for 77 shown photos. Each calculation writes one cache row.
- "On this day" reads one row for each owned album and range, plus about 5 rows for each photo inside the 11-day
  ranges, once in 7 days. This is the price of read isolation.
- Worker CPU: the Worker groups the rows of Places (at most one for each photo with GPS), Wildlife (species, month
  and slot), Gear (lens, camera and year) and "On this day" (12 for each camera day). People does no grouping.
- Live CPU (2026-11-28, `wrangler tail`, milliseconds, one calculation of each part). "Cycle" is the 30-day
  release, "CPU fix" is the release after it:

  | Part | Before the cycle | Cycle: first run, refresh | CPU fix: refresh |
  |---|---|---|---|
  | On this day | 8 | 21, 17 | 5 |
  | People | 4 | 14, 10 | 3 |
  | Gear | 10 | 12, 11 | 8 |
  | Wildlife | 5 | 8, 9 | 5 |
  | Places | 5 | 8, 5 | 3 |
  | Time | 5 | 7, 5 | 3 |

  The refresh request used 0 to 3 ms. Cached reads used 1 to 6 ms (one `time` read used 11 ms). These are single
  samples.
- Cause of the high "cycle" values: date operations in "On this day" and grouping in the Worker in People. The fix
  changed only these two parts.
- Local first call (Node, stub database, median of 41 processes): "On this day" 3.2 to 1.5 ms with the fix (one date,
  before the cycle: 1.0), People 2.2 to 0.1 ms (before the cycle: 0.1).
- The People fix adds D1 rows. Local, 281 sets and 6,582 faces: 18,084 to 24,421 rows, in the same SQL time.
