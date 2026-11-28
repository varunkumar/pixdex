# Dashboard Insights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each user facts about their own photos, and "On this day" photos, on the dashboard.

**Architecture:** The Worker calculates each topic with SQL on the first request of the day and caches one JSON row for each user and topic. The cache holds ids, not photo rows or names. The frontend turns typed fact data into text and plain CSS charts. The agent adds town names from a local GeoNames file.

**Tech Stack:** Hono Worker, D1, React 19, Mantine, TanStack Query, Vitest, Node agent.

**Spec:** `docs/superpowers/specs/2026-11-28-dashboard-insights-design.md`

## Global Constraints

- Scope: photos in albums that the viewer owns. Shared albums are not counted.
- Camera time: `datetime(date_time, '+330 minutes')`, offset in one constant. Do not change stored data.
- Valid date: corrected year 1990 or later, and not after tomorrow.
- Score: `COMBINED_SCORE_SQL`. A hit is a score of 8 or more.
- A fact below its minimum is not returned. No empty tile.
- Skip ignored faces (`+f.ignored_at IS NULL`). Count `auto` and `confirmed`. Only the viewer's own people.
- Resolve names only with `PERSON_NAME_SQL`. Do not change face indexes.
- Worker: `import * as z from 'zod/mini'`. Free plan CPU limit 10 ms. No loop over all photos.
- D1: first visit of a day at most 600,000 rows read for 15,700 photos. No new index without measurements.
- New migrations are additive. `/ingest/*` stays out of the proxy allowlist.
- Each commit updates the applicable docs. All text is ASD-STE100, with no em dashes.
- Run `graphify query` before you search source files. Run `graphify update .` after code changes.
- Do not run a command against live D1 without the owner's permission.

## Review Focus

1. Junk dates (`1899-...`, a future year, `2025:06:02`): time facts and "On this day" skip them (Tasks 1, 2).
2. No scores, or no hits: no division by zero; gear tiles that need hits are absent (Task 3).
3. All photos in one year: `shifts`, `burst` and `progress` are absent, and other facts work (Tasks 2, 3).
4. An album changes owner, or a photo is deleted, after the cache write: the next read drops it (Task 1).
5. Bad `species` JSON or GPS `0,0`: the topic does not fail, and the row is skipped (Tasks 5, 9).

## File Structure

| File | Responsibility |
|---|---|
| `worker/migrations/0024_insights_cache.sql` | Cache table |
| `worker/migrations/0025_photo_place.sql` | `photos.place` |
| `worker/src/insights/common.ts` | Constants, camera time SQL, owner scope, cache |
| `worker/src/insights/{onThisDay,time,gear,wildlife,people,places}.ts` | One builder for each topic |
| `worker/src/insights/types.ts` | Fact types |
| `worker/src/routes/insights.ts` | Routes, cache use, hydration |
| `worker/src/routes/ingest-places.ts` | Pending and write routes for places |
| `src/components/insights/` | `InsightsSection.tsx`, `OnThisDay.tsx`, `FactTiles.tsx`, `charts.tsx`, `factText.ts` |
| `agent/src/places/gazetteer.ts`, `agent/src/backfillPlaces.ts` | Town lookup and backfill |

Delivery: Tasks 1 to 4 are pull request 1. Tasks 5 and 6 are pull request 2. Tasks 7 to 10 are pull request 3.

---

### Task 1: Cache, routes and "On this day"

**Files:**
- Create: `worker/migrations/0024_insights_cache.sql`, `worker/src/insights/common.ts`, `worker/src/insights/types.ts`, `worker/src/insights/onThisDay.ts`, `worker/src/routes/insights.ts`, `docs/agents/insights.md`
- Modify: `worker/src/index.ts`, `functions/api/[[path]].ts`, `AGENTS.md` (feature table row), `docs/architecture.md`, `docs/development.md`
- Test: `worker/test/insights-on-this-day.test.ts`, `worker/test/insights-helpers.ts`, `worker/test/query-plans.test.ts`, `functions/api/proxy.test.ts`

**Interfaces (Produces):**
- Table `insights_cache (email TEXT, topic TEXT, day TEXT, version INTEGER, data TEXT, computed_at TEXT, PRIMARY KEY (email, topic)) WITHOUT ROWID`.
- `common.ts`: `INSIGHTS_VERSION = 1`, `CAMERA_OFFSET_MINUTES = 330`, `HIT_SCORE = 8`, `indiaDate(now: Date): string`, `ownedSql(column: string): string` (binds the email), `datedCte(columns: string): string`, `cached<T>(db: D1Database, email: string, topic: string, day: string, build: () => Promise<T>): Promise<T>`.
- `datedCte` returns `WITH o AS (SELECT <columns>, datetime(date_time, '+330 minutes') AS t FROM photos WHERE <ownedSql>), d AS (SELECT * FROM o WHERE t >= '1990-01-01' AND t < date(?, '+2 days'))`. It binds email, then today.
- `types.ts`: `type Topic = 'time' | 'gear' | 'wildlife' | 'people' | 'places'`; `type TopicBuilder = (db: D1Database, email: string, today: string) => Promise<Fact[]>`; `Fact` is a union on `id` (each later task adds its members).
- `routes/insights.ts`: `const BUILDERS: Partial<Record<Topic, TopicBuilder>>`; `insightsRoute` answers `{ day, facts }`, 404 for a topic with no builder; `onThisDayRoute` answers `{ date, years: [{ year: number, photos: SerializedPhoto[] }] }`.
- `onThisDay.ts`: `onThisDayRanges(date: string): { year: number; from: string; to: string }[]`, `ON_THIS_DAY_SQL`.
- `insights-helpers.ts`: `seedPhoto(p: { dt?: string | null; album?: string; score?: number | null; [column: string]: unknown }): Promise<string>` (any other key is a `photos` column), `getJson(path: string, email?: string)`, `clearInsights()`.

- [ ] **Step 1: Create the branch** `feat/dashboard-insights`. Commit the spec and this plan.

- [ ] **Step 2: Write the failing tests**

```ts
it('builds one window for each earlier year, in camera time', () => {
  const r = onThisDayRanges('2026-11-28').find((x) => x.year === 2025)!;
  expect(r).toEqual({ year: 2025, from: '2025-11-25T18:30:00', to: '2025-11-30T18:30:00' });
  expect(onThisDayRanges('2026-11-28').map((x) => x.year)).not.toContain(2026);
});
it('crosses New Year and treats 29 February as 28 February', () => {
  expect(onThisDayRanges('2027-01-01').find((x) => x.year === 2026)!.from).toBe('2025-12-29T18:30:00');
  expect(onThisDayRanges('2028-02-29').find((x) => x.year === 2027)!.to).toBe('2027-03-02T18:30:00');
});
```

Route tests, each with these assertions:
- A photo at `2025-11-25T23:30:00.000Z` (05:00 on 26 November) is in year 2025. One at `2025-11-25T18:00:00.000Z` is not.
- Years are newest first. A year with 15 photos returns the 12 with the highest score.
- Junk dates `1899-11-28T...`, `2025:11:28` and a `null` date are absent.
- A photo in an album that another user owns and shares with the viewer is absent.
- A date 3 days from `indiaDate(new Date())` gives 400. A bad string gives 400.
- A second request returns the same ids after a new photo is added (cache). A new accepted date or a changed `version` calculates again.
- After a cached photo is deleted, or its album gets a new owner, the next read does not return it. A year with no photos left is dropped.
- `GET /insights/nope` gives 404.
- Proxy: `insights/time` and `insights/on-this-day` are forwarded.
- Query plan: `ON_THIS_DAY_SQL` contains `SEARCH photos USING INDEX idx_photos_date_time (date_time>? AND date_time<?)`.

- [ ] **Step 3: Run** `cd worker && npx vitest run insights query-plans`. Expected: FAIL (module not found).

- [ ] **Step 4: Implement.** `ON_THIS_DAY_SQL` starts from `json_each(?) AS r CROSS JOIN photos`, uses `+photos.album` so that the date index wins, and keeps 12 rows for each year with `ROW_NUMBER()`. Cache `{ years: [{ year, ids }] }`. Hydrate with one `id IN (SELECT value FROM json_each(?))` query that applies `ownedSql` again. Register `/insights/on-this-day` before `/insights/:topic`, both under `requireReadToken`. The cache write is an upsert.

- [ ] **Step 5: Run** `cd worker && npm test && npm run typecheck`, then `npm test` at the root. Expected: PASS.

- [ ] **Step 6: Write docs** (agent note: routes, cache rule, scope, time offset) and commit `feat(worker): add insights cache and On this day`.

### Task 2: Time topic

**Files:** Create `worker/src/insights/time.ts`. Modify `types.ts`, `routes/insights.ts`, `docs/agents/insights.md`. Test `worker/test/insights-time.test.ts`.

**Interfaces:** Consumes Task 1. Produces `timeFacts: TopicBuilder` and:

| id | Data fields |
|---|---|
| `top-month` | `counts: number[]` (12, index 0 is January), `total` |
| `top-weekday` | `counts: number[]` (7, index 0 is Sunday), `total` |
| `records` | `busiest: { date, count }`, `gap: { days, from, to }` |
| `shifts` | `older: { from, to, month }`, `newer: { from, to, month }` (years; month 1 to 12) |

- [ ] **Step 1: Write failing tests** with these assertions:
- 99 dated photos give no `top-month` and no `top-weekday`. 100 give both.
- `2025-03-29T23:30:00.000Z` counts as Sunday, 30 March (`counts[0]`).
- Junk dates do not change `total`.
- `records` needs 10 shooting days. `gap.days` is the date difference between two shooting days.
- `shifts` needs 4 years with 100 photos each. With years 2020 to 2023 it gives older 2020-2021 and newer 2022-2023. With an odd count, the newer half takes the extra year. Equal months give no fact.
- One year of photos gives no `shifts`. A user with no albums gets `facts: []` with status 200.

- [ ] **Step 2: Run** `npx vitest run insights-time`. Expected: FAIL.
- [ ] **Step 3: Implement** with three statements: grouped by year and month, grouped by weekday, and `records` with `LAG` over distinct days (returns the two result rows only). A tie takes the later date, or the earlier month or weekday.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(worker): add time insights`.

### Task 3: Gear topic

**Files:** Create `worker/src/insights/gear.ts`. Modify `types.ts`, `routes/insights.ts`, `docs/agents/insights.md`. Test `worker/test/insights-gear.test.ts`.

**Interfaces:** Produces `gearFacts: TopicBuilder`, `type FocalGroup = 'under-35' | '35-69' | '70-199' | '200-399' | '400-plus'` and:

| id | Data fields | Rule and minimum |
|---|---|---|
| `top-lens` | `lens, hits, photos, knownLensPhotos` | Most hits; 20 hits |
| `hit-rate` | `lenses: { lens, hits, photos }[]` | Top 4 by rate; 2 lenses of 50 |
| `recipe` | `weekday, slot, focal, hits, photos, allHits, allPhotos` | Best rate of weekday + 2-hour slot (0, 2, ... 22) + focal group; group of 50; rate above all photos with date and focal length |
| `zoom` | `lens, min, max, atMax, photos, buckets: { from, to, photos }[]` | Most used lens with max >= 1.5 x min; `atMax` is focal >= 0.95 x max; 5 equal buckets; 100 photos |
| `burst` | `years: { year, photos, moments }[]` | New moment when the gap to the previous photo of the same camera is over 2 s; 2 years of 100 |
| `progress` | `years: { year, photos, hits, camera: string \| null }[]` | Years of 100; at least 2; `camera` is the most used |
| `cameras` | `total, cameras: { camera, first, last, photos }[]` | Top 6 by photos with 20 or more; 2 such cameras; `total` counts all cameras |

- [ ] **Step 1: Write failing tests**: one test at the minimum and one below it for each row above. Also:
- Score 8.0 is a hit and 7.9 is not. A 5-star owner rating changes the hit count (combined score).
- Photos with `null` scores give no `top-lens` and no `recipe`, with status 200.
- A prime lens (min equals max) never appears in `zoom`.
- Three photos at 0 s, 2 s and 5 s are 2 moments. Two cameras at the same second are 2 moments.
- One year of photos gives no `burst` and no `progress`.

- [ ] **Step 2: Run** `npx vitest run insights-gear`. Expected: FAIL.
- [ ] **Step 3: Implement** with five statements: lens totals; recipe groups; zoom; burst; year and camera totals (serves `progress` and `cameras`). Use `datedCte` where a date is necessary.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(worker): add gear insights`.

### Task 4: Dashboard page

**Files:**
- Create: `src/components/insights/{InsightsSection,OnThisDay,FactTiles,charts}.tsx`, `src/components/insights/factText.ts`
- Modify: `src/components/Dashboard.tsx`, `src/services/api/WorkerApiClient.ts`, `src/types/api.ts`, `src/index.css`, `dev/mockApi.ts`, `docs/browsing.md`, `docs/agents/frontend.md`, `README.md`, `docs/screenshots/home.png`
- Test: `src/components/__tests__/{Dashboard,pageSemantics}.test.tsx`, `src/components/insights/__tests__/{factText.test.ts,InsightsSection.test.tsx}`

**Interfaces:**
- Consumes: the responses of Tasks 1 to 3. Copy the `Fact` union into `src/types/api.ts`.
- Produces: `getInsights(topic: InsightTopic): Promise<{ day: string; facts: Fact[] }>`, `getOnThisDay(date: string): Promise<OnThisDayResponse>` (the browser local date).
- `factText.ts`: `describeFact(fact: Fact): { topic: InsightTopic; label: string; value: string; headline: string; note: string; chart: Chart | null }` with `type Chart = { type: 'columns'; values: number[]; labels: string[]; highlight: number } | { type: 'bars'; rows: { label: string; value: number; text: string }[] } | { type: 'spans'; rows: { label: string; start: number; width: number }[] }`.
- `const TOPICS: InsightTopic[]` holds `time` and `gear`. Tasks 5, 6 and 9 add one topic each.

Fixed copy:

| id | label | value (example) | headline | note |
|---|---|---|---|---|
| `top-month` | Top month | `June` | `June is your busiest month` | `<n> of <total> dated photos` |
| `top-weekday` | Top weekday | `Wed` | `Wednesday is your top day` | `<pct> of dated photos` |
| `records` | Records | `312` | `<n> photos in one day` | `<date>. Longest break: <days> days, in your indexed photos.` |
| `shifts` | Peak month moved | `Dec→Mar` | `Your peak month moved from December to March` | `<from>-<to> against <from>-<to>` |
| `top-lens` | Best-rated lens | lens name | `Most of your best photos use <lens>` | `<hits> high-scoring photos. Only photos with a known lens.` |
| `hit-rate` | Hit rate by lens | `24%` | `<lens> wins most often` | `Share that scores 8+, for photos with a known lens` |
| `recipe` | Winning recipe | `Sun 06:00` | `<weekday>, <hh>:00 to <hh+2>:00, <focal text>` | `<pct> score 8+, against <pct> for all photos` |
| `zoom` | Real zoom use | `62%` | `<pct> of shots at the long end` | `<lens>, <min> to <max> mm` |
| `burst` | Burst habit | `6` | `<n> frames for each moment` | `It was <n> in <year>` |
| `progress` | Hit rate by year | `9%→21%` | `Your 8+ share went from <pct> to <pct>` | `Main camera in <year>: <camera>` |
| `cameras` | Camera eras | `38` | `<n> cameras` | `First to last use, top <n> shown` |

Focal text: `under 35 mm`, `35 to 69 mm`, `70 to 199 mm`, `200 to 399 mm`, `400 mm or more`. Percentages are whole numbers. `burst` frames have one decimal at most. `progress` omits the camera sentence when `camera` is null.

- [ ] **Step 1: Write failing tests**
- `factText`: for each id above, one fixture and the exact `value`, `headline` and `note`.
- Page order: counts line, "On this day", chips, tiles, "Recently indexed". The `Search`, `Albums` and `Daily pick` link cards are gone. The counts stay links to `/search` and `/albums`.
- A tile is a button with `aria-expanded`. A tap shows the headline. A second tile closes the first.
- A chip click sets `?topic=gear` and shows only gear tiles. `/?topic=gear` starts filtered. An unknown value shows All.
- The open tile returns after Back (`leaveAndGoBack`).
- A chip with no facts is absent. With no facts and no years, there are no chips, no tiles and no "On this day".
- One failed topic shows `Could not load gear facts.` and a `Retry` button. The other tiles show.
- An "On this day" photo links to `/photos/:id`, under a heading `<year> · <n> years ago`.
- `pageSemantics`: add the two API names and mocks. One `h1`, no skipped heading level.

- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** One query for each topic (key `['insights', topic]`) and one for On this day (key `['on-this-day', date]`), `staleTime` one hour. Chip in `useSearchParams`, open tile in `useHistoryState('open-fact', null)`. Tile grid: 2 columns, 3 at 576px, 4 at 992px. Charts are CSS only, with theme colors, and the chart has a text alternative.
- [ ] **Step 4: Add mock data**, run `PIXDEX_MOCK=1 npm run dev`, check phone and desktop widths in both themes, and take the new screenshot.
- [ ] **Step 5: Run** `npm test && npm run lint && npm run build`. Expected: PASS. Write docs. Commit `feat: show insights and On this day on the dashboard`.

### Task 5: Wildlife topic

**Files:** Create `worker/src/insights/wildlife.ts`. Modify `types.ts`, `routes/insights.ts`, `src/types/api.ts`, `factText.ts`, `TOPICS`, `dev/mockApi.ts`, docs. Test `worker/test/insights-wildlife.test.ts`, `factText.test.ts`.

**Interfaces:** Produces `wildlifeFacts: TopicBuilder` and:
- `life-list`: `total, year, newInYear, once, byYear: { year, total }[]` (running total, last 5 years).
- `best-chance`: `species, photos, month, slot, slots: { slot, photos }[]`.

Copy: `Life list` / `<total>` / `<total> species, <n> new in <year>` / `<once> species seen only once`. `Best chance` / month short name / `<species>: <month>, <hh>:00 to <hh+2>:00` / `From <n> photos of this species`.

- [ ] **Step 1: Write failing tests**: 4 species give no `life-list`; 29 photos of a species give no `best-chance`; the same species twice in one photo counts once; a row with `species = 'not json'` is skipped with status 200; `year` is the current year if it has a new species, else the year before; `once` counts species in exactly one photo.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement** with `json_each` over `CASE WHEN json_valid(species) THEN species ELSE '[]' END`, name `json_extract(value, '$.common')`, two statements.
- [ ] **Step 4: Run** all Worker and root tests. Expected: PASS. Commit `feat: add wildlife insights`.

### Task 6: People topic

**Files:** Create `worker/src/insights/people.ts`. Modify the same set as Task 5 and `routes/insights.ts` (hydration). Test `worker/test/insights-people.test.ts`, `query-plans.test.ts`.

**Interfaces:** Produces `peopleFacts: TopicBuilder`, `TOGETHER_SQL`, and `hydrateFacts(db: D1Database, email: string, facts: Fact[]): Promise<unknown[]>`. Cached data holds `together: { pairs: { a: string, b: string, photos }[] }` and `missed: { person: string, lastDate, photos }`. The response replaces each id with `{ id, name }`.

Copy: `Together` / `<photos>` / `<A> and <B> appear together most` / `Photos with both people`. Bars: `<A> + <B>`. `Missed` / `<n> yr` / `No photo of <name> for <n> years` / `Last seen <month year>, in your indexed photos`.

- [ ] **Step 1: Write failing tests**: pair of 9 gives no `together`; top 3 pairs; two faces of one person in a photo count once; an ignored face and an `unassigned` face do not count; another owner's person never appears; `missed` needs 20 photos and a last photo over 365 days ago, and takes the oldest; after a rename the cached response shows the new name; after a person is deleted, the pair or fact is dropped.
- Query plan: `TOGETHER_SQL` uses `idx_faces_photo_id` for the second face and has no `SCAN f`.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.** Start from the owner's persons with `CROSS JOIN faces`. Resolve names in one statement with `PERSON_NAME_SQL` and `nameBinds`. No embedding is read.
- [ ] **Step 4: Run** all tests. Expected: PASS. Update `docs/agents/people.md`. Commit `feat: add people insights`.

### Task 7: `photos.place` and its ingest routes

**Files:** Create `worker/migrations/0025_photo_place.sql`, `worker/src/routes/ingest-places.ts`. Modify `index.ts`, `ingest-exif.ts`, `ingest-photo.ts`, `db/photos.ts`, `docs/indexing.md`, `docs/development.md`, `docs/agents/indexing.md`. Test `worker/test/ingest-places.test.ts`.

**Interfaces:** Produces:
- `POST /ingest/places/pending` `{ cursor?, limit }` (1 to 100) → `{ items: { contentHash, latitude, longitude }[], nextCursor }`. Pending: GPS present and `place IS NULL`.
- `POST /ingest/places` `{ photos: { contentHash, place }[] }` (1 to 100, place up to 120 characters, `''` allowed) → `{ updated, unknown }`.
- `POST /ingest/photo` accepts optional `place`.

- [ ] **Step 1: Write failing tests**: paging by cursor; `''` removes a photo from pending; 101 photos give 400; the read token gives 401; `/ingest/exif` with new GPS sets `place` to NULL and with the same GPS keeps it; a re-index with no `place` keeps it only if the GPS is the same; search results do not change.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.** Follow `ingest-species.ts`. In both upserts use `IS` to compare the old and new GPS values.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS. Commit `feat(worker): store photo places`.

### Task 8: Agent town lookup and backfill

**Files:** Create `agent/src/places/gazetteer.ts`, `agent/src/backfillPlaces.ts`. Modify `cli.ts`, `cloudflareClient.ts`, `processFile.ts`, `indexLocalFolder.ts` and the Drive path that builds its deps, `config.ts`, `.env.example` if present, `docs/indexing.md`. Test `agent/test/{places-gazetteer,backfillPlaces,processFile}.test.ts`.

**Interfaces:** Produces:
- `parseGazetteer(text: string): Gazetteer` (GeoNames tab columns: 1 name, 4 latitude, 5 longitude, 8 country; zero-based).
- `nearestTown(g: Gazetteer, lat: number, lon: number, maxKm = 50): string` → `"Town, CC"` or `''`.
- `loadGazetteer(file?: string): Promise<Gazetteer | undefined>`; default `agent/.index-state/geonames/cities500.txt`, override `GEONAMES_FILE`.
- `CloudflareClient.placesPending(cursor, limit)`, `ingestPlaces(photos)`.
- CLI `backfill-places [--dry-run]`. A missing file exits 1 and prints the download steps for `https://download.geonames.org/export/dump/cities500.zip`.

- [ ] **Step 1: Write failing tests** with a 4-town fixture: nearest town wins; over 50 km gives `''`; a town across the 180 degree line and across a degree cell edge is found; backfill pages to the end and writes batches of 100; `--dry-run` writes nothing; indexing sends `place` only when the file is loaded and the photo has GPS.
- [ ] **Step 2: Run** `cd agent && npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** Index towns by whole-degree cell. Search the neighbor cells, wider in longitude at high latitude. No new dependency.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS. Add the GeoNames CC BY 4.0 credit. Commit `feat(agent): add town names from GPS`.

### Task 9: Places topic

**Files:** Create `worker/src/insights/places.ts`. Modify the same set as Task 5. Test `worker/test/insights-places.test.ts`, `factText.test.ts`.

**Interfaces:** Produces `placesFacts: TopicBuilder` and:
- `travel`: `km, place: string | null, date, gpsPhotos`.
- `places`: `year, newCount, top: { place, days, photos }[], gpsPhotos`.

Copy: `Travel` / `<km> km` / `Your farthest photo: <km> km` / `<near <place>, if present>From your usual spot. Only photos with GPS.`. `Places` / `<newCount> new` / `<newCount> new places in <year>` / `Days with photos. Only photos with GPS.`. Bars: `Near <place>`.

- [ ] **Step 1: Write failing tests**: 99 GPS photos give no `travel`; 19 photos with a place give no `places`; the usual spot is the 0.1 degree cell with the most days, not the most photos; Bengaluru to Mysuru is 120 to 140 km; GPS `0,0` is skipped; `''` and NULL places are skipped; `year` follows the `life-list` rule.
- [ ] **Step 2: Run** the tests. Expected: FAIL.
- [ ] **Step 3: Implement.** One statement groups cells (`round(latitude, 1), round(longitude, 1)`, average position, distinct days). The Worker applies haversine to the cells only. One statement groups places.
- [ ] **Step 4: Run** all tests. Expected: PASS. Commit `feat: add places insights`.

### Task 10: Cost check

Do Steps 1 to 3 before each pull request merges, for the topics in it.

**Files:** Test `worker/test/insights-cost.test.ts`. Modify `docs/development.md`, `docs/agents/insights.md`.

- [ ] **Step 1: Write the test**: seed 2,000 photos in 20 albums with dates, lenses, species, GPS and faces. Sum `meta.rows_read` of every builder statement. Assert the sum is at most `38 * 2000`. Assert that a cached request for all topics reads under 100 rows plus the hydrated rows.
- [ ] **Step 2: Run** it. If it fails, combine statements. If it still fails, stop and tell the owner the measured value.
- [ ] **Step 3: Write** the measured rows into `docs/agents/insights.md`. Run `graphify update .`.
- [ ] **Step 4: Ask the owner** before this read-only live count, then change `HIT_SCORE` if hits are under 5% or over 40%: `SELECT SUM(score >= 8) * 100.0 / COUNT(score) FROM (SELECT <COMBINED_SCORE_SQL> AS score FROM photos)`. A change updates the copy (`8+`) and raises `INSIGHTS_VERSION`.
- [ ] **Step 5: After release**, give the owner the `wrangler d1 insights` and `wrangler tail` commands. Record the real values.
