# Dashboard insights: design

Date: 2026-11-28. Status: approved by the owner on 2026-11-28.

## Intent

The dashboard shows two counts, recent photos and three links. It must tell each user facts about their photos that they
do not normally see. It must also show photos from the same days in earlier years.

## Goals

- Show the facts in this document, calculated from real data.
- Show "On this day": photos from today, plus or minus two days, in earlier years.
- Calculate each result at most once per day for each user.
- Work well on a phone.

## Non-goals

- No places from album names, and no manual place entry. Places come from GPS only.
- No outside service for place names.
- No links from a tile to a filtered photo list in this version.
- No fix for the Timeline and `onThisDay` search time zone bug (see "Known problem"). It is separate work.

## Anti-goals

- A fact that is wrong because the sample is very small.
- A fact that says one thing caused another.
- A dashboard request that breaks the Worker CPU limit of 10 ms.

## Data on 2026-11-28 (live, read-only counts)

15,695 photos, 259 albums, indexing still in progress. Capture date 98%, camera 98%, focal length 96%, lens name 31%
(13 lenses), species 21%, GPS 11% (1,684 photos), model score 100%, owner stars 5 photos, 38 cameras.

## Approaches

| Approach | Trade-off | Result |
|---|---|---|
| A. Calculate at the first visit of the day, cache in D1 | The first visit is slower | **Chosen by the owner** |
| B. Calculate each night with a cron trigger | Calculates for absent users; one CPU limit for all users | Rejected |
| C. Calculate in the agent | The computer must run; names and owner edits live in D1 | Rejected |

## Common rules

- **Scope:** only photos in albums that the viewer owns. Shared albums are not counted. (Builder proposal, not objected.)
- **Camera time:** all indexing used a computer set to India time. Use `datetime(date_time, '+330 minutes')` to get the
  camera clock time. Put the offset in one constant. Do not change stored data.
- **Valid date:** the corrected year is 1990 or later, and the date is not after tomorrow. Time facts skip other photos.
- **Score:** `COMBINED_SCORE_SQL`. A **hit** is a score of 8 or more.
  - Before release, count the score distribution (read-only, ask the owner). Change the threshold if hits are
    less than 5% or more than 40% of photos.
- **Minimum sample:** a fact below its minimum is not returned. The tile is then absent. Never show an empty tile.
- **Partial data:** a note that depends on partial data says so ("of photos with a known lens", "of photos with GPS").
- **Owner data:** skip ignored faces. Count faces with status `auto` or `confirmed`. Only the viewer's own people.
- **Species:** use the stored `species` entries. Count each species once per photo.

## Facts

| Id | Topic | Fact | Definition | Minimum |
|---|---|---|---|---|
| `top-month` | Time | Top month | Photos per calendar month | 100 dated photos |
| `top-weekday` | Time | Top weekday | Photos per weekday | 100 dated photos |
| `records` | Time | Records | Busiest day; longest gap between two shooting days | 10 shooting days |
| `shifts` | Time | Peak month moved | Top month in the older half of the years and in the newer half. Absent if equal | 4 years of 100 photos |
| `top-lens` | Gear | Best-rated lens | Lens with the most hits | 20 hits, known lens |
| `hit-rate` | Gear | Hit rate by lens | Share of hits per lens, top 4 | 2 lenses of 50 photos |
| `recipe` | Gear | Winning recipe | Best hit rate for weekday + 2-hour slot + focal group, against all photos | Group of 50, rate above average |
| `zoom` | Gear | Real zoom use | Most used zoom lens (observed max focal >= 1.5 x min). Share at 95% of observed max or more | 100 photos |
| `burst` | Gear | Burst habit | A moment ends when the gap to the previous photo of that camera is over 2 s. Frames per moment per year | 2 years of 100 photos |
| `progress` | Gear | Hit rate by year | First and latest year, with the most used camera of each year | 2 years of 100 photos |
| `cameras` | Gear | Camera eras | First and last use, top 6 cameras. Headline: number of cameras | 2 cameras of 20 photos |
| `life-list` | Wildlife | Life list | Species total; new this year (else last year); species in one photo only | 5 species |
| `best-chance` | Wildlife | Best chance | For the most photographed species: top month and 2-hour slot | 30 photos of it |
| `together` | People | Together | Top 3 pairs of people by shared photos | Pair with 10 photos |
| `missed` | People | Missed | Person with the oldest last photo, over 1 year ago | Person with 20 photos |
| `travel` | Places | Farthest photo | Distance from the usual spot (the 0.1 degree cell with the most days) | 100 GPS photos |
| `places` | Places | Places | Places new this year (else last year); top 3 places by days | 20 photos with a place |

Notes:

- The notes under `missed` and `records` say "in your indexed photos", because indexing is not complete.
- `progress` shows the camera as context only. It does not say that the camera caused the change.
- A focal group is: under 35, 35 to 69, 70 to 199, 200 to 399, 400 mm or more.

## On this day

- The browser sends its local date. The Worker accepts it only within two days of its own India date.
- For each earlier year from 1990, take the window from date minus 2 days to date plus 2 days, in camera time.
  A window can cross New Year. Label it with the year of the middle date. Handle 29 February as 28 February.
- Use `date_time` ranges (shifted by the offset), so that `idx_photos_date_time` serves the query. Send all ranges in
  one statement with `json_each`. Pin the query plan in `worker/test/query-plans.test.ts`.
- Show each year that has photos, newest first, with at most 12 photos by score.
- Show the section only if at least one year has photos.
- A tap opens the photo page.

## Places

- New migration column: `photos.place` (TEXT, NULL until resolved, empty string when no town is near).
- The agent resolves GPS to the nearest town with a local GeoNames file (`cities500`, CC BY 4.0, add the credit to the
  docs). Maximum distance 50 km. The file is downloaded to `agent/.index-state/` and is not committed.
- New command `backfill-places [--dry-run]`. It reads pending photos from the Worker, so it needs no photo files.
- New ingest-token routes: `POST /ingest/places/pending` (rowid cursor, at most 100) and `POST /ingest/places` (at most
  100 by content hash). Keep them out of the proxy allowlist.
- Indexing also sends `place` for new photos (optional field; absent keeps the stored value).
- When `POST /ingest/exif` changes the GPS position, set `place` to NULL, so that the backfill resolves it again.
- Store a place as "town, country code", so that two towns with one name stay separate.
- The note says "near <town>". A forest or park shows the nearest town name.

## API and cache

- `GET /insights/:topic` (`time`, `gear`, `wildlife`, `people`, `places`) returns `{ day, facts }`. The Worker returns
  typed data. The frontend writes the text and draws the charts.
- `GET /insights/on-this-day?date=YYYY-MM-DD` returns `{ date, years }`.
- Add both to the proxy allowlist. Use `requireReadToken`.
- New table `insights_cache (email, topic, day, version, data, computed_at)`, primary key `(email, topic)`. One row per
  user and topic, replaced on each new day or new `version`. Raise `version` when a definition changes.
- Facts use the India date as `day`. "On this day" uses the accepted browser date.
- The cache write happens in a GET. It writes only the viewer's own row.
- Cache photo ids and person ids only, not photo rows or names. On each read, load them by primary key, check
  ownership again, resolve names with `PERSON_NAME_SQL`, and drop what no longer exists.
- Two first requests at the same time can both calculate. The last write wins. This is acceptable.
- A new share or owner edit shows in the facts the next day.

## Frontend

Order on the page (layout B, "Tiles", chosen by the owner):

1. One line with the photo and album counts.
2. "On this day".
3. Topic chips: All, Time, Gear, Wildlife, People, Places. The chip is in the address (`?topic=`).
4. Tiles: two columns on a phone, more on wide screens. A tile shows a label and a short value.
5. A tap expands the tile to full width with the headline, chart and note. One tile is open at a time. Keep it in
   `useHistoryState`.
6. "Recently indexed", unchanged.

- Remove the three link cards.
- Each topic loads alone. Its tiles appear when ready. A failed topic shows one line with "Retry".
- A user with no owned albums sees no "On this day", chips or tiles. A chip with no facts is hidden.
- Charts use plain HTML and CSS. Add no chart library. Support light and dark themes.
- Add mock data to `dev/mockApi.ts`. Update `docs/screenshots/home.png` with dummy data.

Mockup (made-up data): https://claude.ai/artifact/Kq9Hqd5LJBJNb1Dy8S3wJU

## Performance

Worker CPU:

- All grouping and counting happens in SQL. No loop runs over all photos in the Worker.
- The Worker maps at most a few hundred result rows per request. Distance uses grouped GPS cells.
- No embeddings are read.

D1 (estimates, not measured):

- First visit of a day: about 200,000 to 600,000 rows read per user, 5 to 6 rows written. This is higher than the first
  estimate given in the discussion (150,000 to 300,000).
- On this day: about a few hundred rows.
- Later visits: under 100 rows for each full page load, plus a few rows for each "On this day" photo shown (measured
  265 rows for 77 photos).
- Combine facts that group the same rows into one statement. Do not add an index without measurements.
- Use `INDEXED BY` and `+ignored_at` rules from `docs/agents/people.md`. Check each query with `EXPLAIN QUERY PLAN`.
- Measure on local D1 before merge. If a first visit is above 600,000 rows, tell the owner before release.
- After release, measure with `wrangler d1 insights` and `wrangler tail`.

## Tests

- Worker: each fact with its minimum, the time offset (a 05:00 photo stays on its day), the New Year and leap-day
  windows, owner scope (a shared album is not counted), ignored faces, cache hit, new day, new version.
- Agent: nearest town, maximum distance, backfill paging.
- Frontend: tile open and close, chip in the address, hidden empty topics, no-owned-albums state.

## Docs

New `docs/agents/insights.md` with a row in `AGENTS.md`. Update `docs/browsing.md`, `docs/indexing.md`,
`docs/architecture.md`, `docs/development.md` (migration) and the `README.md` feature list.

## Known problem (not in this work)

The Timeline and the `onThisDay` search group by the stored UTC value. Photos from before 05:30 appear on the previous
day.

## Left to the builder

Query shapes, component split, exact text of each tile, and chart styling.

## Delivery order

1. Cache, API, "On this day" and the page layout, with the Time and Gear topics.
2. Wildlife and People topics.
3. Place column, agent backfill and Places topic.
