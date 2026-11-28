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

## Cost

- Cached request: one cache row, plus the hydrated photos by primary key.
- On this day, first request of a date: only the photos inside the windows, plus one owner lookup, one upsert.
