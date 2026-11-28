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
  29 February counts as 28 February. `ON_THIS_DAY_SQL` must search `idx_photos_date_time` (pinned in
  `worker/test/query-plans.test.ts`).

## Topics

A fact below its minimum is not returned. Definitions and minimums are in the code of each builder.

- `time` (`insights/time.ts`, 3 statements): `top-month`, `top-weekday` (100 dated photos), `records` (10 shooting
  days), `shifts` (4 years of 100 photos; the newer half takes the extra year; absent when the peak month is equal).

- `gear` (`insights/gear.ts`, 5 statements): `top-lens` (20 hits), `hit-rate` (2 lenses of 50, top 4), `recipe`
  (weekday, 2-hour slot and focal group of 50, above the average), `zoom` (most used lens with max >= 1.5 x min and 100
  photos), `burst` (a new moment after 2 s for each camera; 2 years of 100), `progress` (2 years of 100; the camera is
  context, not a cause), `cameras` (2 with 20 photos, top 6). A hit is a combined score of `HIT_SCORE` (8) or more.

- `wildlife` (`insights/wildlife.ts`, 2 statements): `life-list` (5 species; the year is the current one if it added a
  species, else the year before), `best-chance` (30 photos of the most photographed species; the slot is within its
  busiest month). Bad `species` text counts as none.

## Cost

- Cached request: one cache row, plus the hydrated photos by primary key.
- On this day, first request of a date: only the photos inside the windows, plus one owner lookup, one upsert.
