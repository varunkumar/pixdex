# Lower dashboard D1 reads: implementation plan

**Spec:** `docs/superpowers/specs/2026-11-28-insights-read-cost-design.md`

**Rule for all tasks:** write the test first and see it fail. The existing fact tests must pass without changes in
meaning. Queries start from the caller's albums or persons.

## Measured facts that shape the plan (local D1, 2,000 photos)

- A pass with no sort reads about 1 row per photo. A `GROUP BY` reads 2. The burst window reads 5.
- So Gear cannot reach 110,000 rows without more Worker CPU. **Ruling:** split the Gear cache in two parts that
  refresh on different days (`gear` and `gear-recipe`). The route and the answer do not change. This keeps the
  goal for the worst day.
- Six cache cycles then start 5 days apart.

## Tasks

1. **Cache** (`insights/common.ts`, `routes/insights.ts`, test `insights-cache.test.ts`)
   - `periodStart(today, offset)`: first India day of the 30-day cycle. Offsets: time 0, gear 5, wildlife 10,
     people 15, places 20, gear-recipe 25.
   - `cached(db, email, topic, period, today, build, isEmpty)`: an empty value is stored under `empty:<today>`.
   - `INSIGHTS_VERSION = 3`.
2. **On this day** (`insights/onThisDay.ts`): `blockStart(date)` (7-day blocks) and `onThisDayBlock(db, email, start)`
   returning `Record<date, { year, ids }[]>`. One statement gives the 12 best photos of each camera day in each
   year's block window. The Worker gives them to the dates in rank order.
3. **People**: one statement, one row for each set of people who share photos. The Worker makes pairs and "missed".
4. **Places**: one statement grouped by cell, place and day.
5. **Wildlife**: one statement grouped by species, month and slot.
6. **Gear**: one statement for lens, year and camera with the burst window; one pass for the zoom bins; the recipe
   statement unchanged in its own cache part.
7. **Cost test, plan tests, docs** (`insights-cost.test.ts`, `query-plans.test.ts`, `docs/agents/insights.md`,
   `docs/browsing.md`, `docs/development.md`).

## Local limits for the cost test (2,000 photos, 500 faces)

| Topic | Today | Limit |
|---|---|---|
| time | 4,059 | 4,100 |
| gear | 31,029 | 19,000 |
| wildlife | 5,326 | 3,500 |
| people | 4,326 | 2,600 |
| places | 4,569 | 2,500 |

## Review focus

- A cached empty value must not stay valid after its day.
- 29 February and New Year inside a seven-day block.
- Facts with ties give the same winner as before.
- Gear Worker work does not grow with the number of photos.
