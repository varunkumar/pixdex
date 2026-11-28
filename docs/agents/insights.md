# Dashboard insights and "On this day"

Agent notes. Read this file before you change this area. Update it with each change.
The core rules are in [`AGENTS.md`](../../AGENTS.md). Paths are relative to the repository root.

## Routes

- `GET /insights/:topic` returns `{ day, facts }`. `BUILDERS` in `worker/src/routes/insights.ts` lists the topics. An
  unknown topic gives 404.
- `GET /insights/on-this-day?date=YYYY-MM-DD` returns `{ date, years: [{ year, photos }] }`. The date must be within
  two days of the India date, else 400.
- Both use `requireReadToken` and are in the proxy allowlist.

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
- **Cache:** `insights_cache` (migration `0024`) has one row for each user and topic. It is valid for one `day` and
  one `INSIGHTS_VERSION`. Raise the version when a definition or a cached shape changes. The GET writes only the
  caller's own row.
- The cache holds ids and numbers, never photo rows or names. Each read loads them again and checks ownership. A new
  share or owner edit shows in the facts the next day.
- "On this day": one window of date ±2 days for each year from 1990, 12 photos for each year by combined score.
  29 February counts as 28 February. `ON_THIS_DAY_SQL` must search the `(album, date_time)` index for each owned
  album and window (pinned in `worker/test/query-plans.test.ts`).

## Topics

A fact below its minimum is not returned. Definitions and minimums are in the code of each builder.

- `time` (`insights/time.ts`, 1 statement that returns the shooting days): `top-month`, `top-weekday` (100 dated photos), `records` (10 shooting
  days), `shifts` (4 years of 100 photos; the newer half takes the extra year; absent when the peak month is equal).

- `gear` (`insights/gear.ts`, 5 statements): `top-lens` (20 hits), `hit-rate` (2 lenses of 50, top 4), `recipe`
  (weekday, 2-hour slot and focal group of 50, above the average), `zoom` (most used lens with max >= 1.5 x min and 100
  photos), `burst` (a new moment after 2 s for each camera; 2 years of 100), `progress` (2 years of 100; the camera is
  context, not a cause), `cameras` (2 with 20 photos, top 6). A hit is a combined score of `HIT_SCORE` (7) or more (16% of the
  live library on 2026-11-28; change the "7+" text in `factText.ts` with it).

- `wildlife` (`insights/wildlife.ts`, 2 statements): `life-list` (5 species; the year is the current one if it added a
  species, else the year before), `best-chance` (30 photos of the most photographed species; the slot is within its
  busiest month). Bad `species` text counts as none.

- `people` (`insights/people.ts`, 2 statements): `together` (top 3 pairs with 10 shared photos), `missed` (20
  photos, last one over 365 days ago, the oldest). Only the caller's own people; auto and confirmed faces; never
  ignored ones. The cache holds person ids. `hydrateFacts` resolves names with `PERSON_NAME_SQL` on each read and
  drops deleted people. `TOGETHER_SQL` finds the second face through `idx_faces_photo_id` (plan pinned).

- `places` (`insights/places.ts`, 2 statements): `travel` (100 photos with GPS; from the 0.1 degree cell with the most
  days to the farthest cell), `places` (20 photos with a place; places new in the current year, else the year before;
  top 3 by days). Dated photos only. GPS 0,0 is skipped. Place names come from the agent (`photos.place`).

## Cost

- Measured on local D1 (`worker/test/insights-cost.test.ts`, 2,000 photos, 500 faces): the first visit of a day reads
  51,422 rows, 26 for each photo. That is about 405,000 rows for 15,700 photos. The limit is 38 for each photo.
- A cached full visit reads 265 rows for 77 shown photos.
- First visit writes: 6 cache rows.
- `burst` is the most costly statement (6 rows for each photo, because of its window function).
- Do not split the time statement again: three statements read 36 rows for each photo, one reads 2.
- On this day, first request of a date: one row for each owned album and year (about 9,000 to 10,000 for 259 albums,
  estimated), plus the owner's photos inside the windows, and one upsert. This is the price of read isolation.
- Worker CPU is not measured. Time walks the shooting days (a few thousand at most). All other topics handle grouped
  rows. Check `cpuTime` with `wrangler tail`.
