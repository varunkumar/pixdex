# Timeline View and Date Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Google Photos style Timeline page (highlights by default, zoom reveals more, year/month scrubber) and date filtering in Search.

**Architecture:** Two new read-only Worker routes (`/timeline`, `/timeline/buckets`) and `from`/`to`/`onThisDay` filters on `/search`, all sharing one date-filter helper. The frontend adds a Timeline page with an infinite query paged by date group, a scrubber fed by month buckets, and date controls plus a pure `parseDateQuery()` in Search. No migration: `photos.date_time` is an indexed ISO string.

**Tech Stack:** Hono Worker + D1 (vitest with `cloudflare:test`), React 19 + Vite + Mantine 9 + react-query + react-router, `@mantine/dates` (new dependency, needs `dayjs`).

**Spec:** `docs/superpowers/specs/2026-11-06-timeline-and-date-search-design.md`

## Global Constraints

- Ranking uses `COMBINED_SCORE_SQL` from `worker/src/db/rating.ts`, never `aesthetic_score` directly.
- Month-level cut-off: `HIGHLIGHT_THRESHOLD = 6.0` (named constant, tune later). `MIN_PER_GROUP = 3`. Year level takes rank <= `YEAR_CAP = 6` per month, ignoring the threshold.
- Display order inside every group is `date_time DESC, id`, whatever was used to select photos.
- Unrated photos (null combined score) and Undated photos appear only at Day level. Undated is one group, last.
- Group keys: month `YYYY-MM`, day `YYYY-MM-DD`, undated `undated`, taken from `substr(date_time, ...)` of the stored string (no timezone conversion).
- Scrubber buckets are true counts per month, independent of zoom and cut-off.
- All new Worker routes are GET only and read only. Add them to the Pages proxy `ALLOWED_PATHS`. `/ingest/*` stays out. Bind all user input; never interpolate.
- Invalid `from`/`to`/`onThisDay`/`zoom` returns 400 `{ error }`.
- "On this day" is `onThisDay=MM-DD`, mutually exclusive with `from`/`to` (400 if both).
- No `VITE_` secrets. Do not edit `agent/`. Do not bypass the pre-commit hook.
- Update `README.md`, `AGENTS.md` and `docs/architecture.md` in the final commit.
- No em dashes in any text written.

## Review Focus

- `from` after `to`: 400, not an empty result.
- `onThisDay=02-29` and `to=2024-02-29`: leap day accepted, `2025-02-30` rejected.
- Photos whose `date_time` is null or not ISO-shaped never crash grouping and fall in Undated.
- A month with zero scored photos shows 0 and says "zoom in to see" instead of vanishing from the feed.
- Empty library or filters matching nothing: Timeline and Search show an empty state, not a spinner or error.

---

### Task 1: Date filters on `/search`

**Files:**
- Create: `worker/src/db/dateFilter.ts`
- Modify: `worker/src/routes/search.ts:7-37` (parse params, append SQL)
- Test: `worker/test/search.test.ts` (add cases), `worker/test/date-filter.test.ts` (new, unit)

**Interfaces:**
- Produces: `parseDateFilter(q: (name: string) => string | undefined): { ok: true; filter: DateFilter } | { ok: false; error: string }`; `DateFilter = { from?: string; toExclusive?: string; onThisDay?: string }` (`from` is `YYYY-MM-DD`, `toExclusive` is the day after `to`); `dateFilterSql(f: DateFilter, column?: string): { sql: string; params: unknown[] }` returning clauses prefixed with ` AND ` (empty string when no filter), default column `photos.date_time`.

- [ ] **Step 1: Write failing unit tests** in `date-filter.test.ts`: `parseDateFilter` accepts `from=2025-06-01&to=2025-06-30` and yields `toExclusive='2025-07-01'`; accepts `to=2024-02-29`; rejects `2025-02-30`, `from=2025-07-01&to=2025-06-01`, `onThisDay=13-01`, and `onThisDay=06-14` combined with `from`; accepts `onThisDay=02-29`. `dateFilterSql` returns `{ sql: '', params: [] }` for an empty filter.
- [ ] **Step 2: Write failing route tests** in `search.test.ts`: seed photos dated `2025-06-14T10:00:00.000Z`, `2025-06-30T23:59:59.000Z`, `2025-07-01T00:00:00.000Z`, `2024-06-14T09:00:00.000Z`, and one with null `date_time`. `/search?from=2025-06-01&to=2025-06-30` returns exactly the first two (end of day inclusive); `onThisDay=06-14` returns the 2025 and 2024 June 14 photos; a bad date returns 400; date filter combines with `album`.
- [ ] **Step 3: Run** `cd worker && npx vitest run test/date-filter.test.ts test/search.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** `parseDateFilter` and `dateFilterSql` in `dateFilter.ts` (validate with a real calendar check via `Date.UTC` round trip; `onThisDay` SQL is `substr(col, 6, 5) = ?`; range SQL is `col >= ? AND col < ?`, both clauses only when present). Wire into `searchRoute`: return `c.json({ error }, 400)` on failure, append `dateFilterSql(...)` to `from` in `run()`.
- [ ] **Step 5: Run** the same command plus `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(worker): date range and on-this-day filters on /search`.

---

### Task 2: `/timeline` and `/timeline/buckets` routes

**Files:**
- Create: `worker/src/routes/timeline.ts`, `worker/test/timeline.test.ts`
- Modify: `worker/src/index.ts` (register after `/search`, line ~51)

**Interfaces:**
- Consumes: `parseDateFilter`, `dateFilterSql` (Task 1); `COMBINED_SCORE_SQL`; `serializePhoto`, `PhotoRow` from `worker/src/db/photos.ts`.
- Produces:
  - `GET /timeline?zoom=year|month|day&album&people&from&to&cursor&groups` where `groups` is groups per page (default 6, 1..24) and `cursor` is the last group key already returned (exclusive; groups proceed newest to oldest, `undated` last at day zoom). Response `{ groups: TimelineGroup[]; nextCursor: string | null }`, `TimelineGroup = { key: string; total: number; shown: number; photos: SerializedPhoto[] }`. `total` counts every photo in the group under the album/people/date filters, ignoring the cut-off. `zoom` defaults to `month`; unknown value is 400.
  - `GET /timeline/buckets?album&people` returns `{ buckets: { month: string; total: number }[]; undated: number }`, newest month first.
  - Exported constants `HIGHLIGHT_THRESHOLD = 6.0`, `MIN_PER_GROUP = 3`, `YEAR_CAP = 6`.

- [ ] **Step 1: Write failing tests** in `timeline.test.ts` (seed helper with `date_time`, `aesthetic_score`, `user_rating`, `album`):
  - month zoom: a month with 5 photos scored 9, 8, 7, 5, 2 shows the first three; a month with scores 5, 4, 3, 2 shows the top 3 (min rule) with `total: 4, shown: 3`; a month with only unrated photos returns `shown: 0, total: n`.
  - year zoom caps at 6 per month even if all score 9; day zoom returns every photo including unrated and groups by `YYYY-MM-DD`; undated group appears last at day zoom only.
  - photos inside a group are ordered `date_time DESC`.
  - cursor paging: `groups=2` returns `nextCursor` equal to the second key, the next call returns the following groups with no overlap, and the final page has `nextCursor: null`.
  - owner `user_rating` dominates: a 5-star photo with `aesthetic_score` 2 is shown at month zoom.
  - `album` and `people` filters, `from`/`to` (a jump `to=2025-03-31` starts the feed at March 2025), 400 on bad `zoom`.
  - `/timeline/buckets` returns true monthly totals, ignoring rating, plus `undated` count.
- [ ] **Step 2: Run** `cd worker && npx vitest run test/timeline.test.ts`. Expected: FAIL (route missing).
- [ ] **Step 3: Implement `timelineRoute` and `bucketsRoute` in `timeline.ts`.** Approach: one SQL pass to get group keys and totals for the filtered set (`substr(date_time,1,7)` or `1,10`, `GROUP BY key ORDER BY key DESC`, keyset `key < ?`, `LIMIT groups + 1` to detect `nextCursor`), then one query for the page's photos using `ROW_NUMBER() OVER (PARTITION BY key ORDER BY combined_score IS NULL, combined_score DESC, date_time DESC)` and keeping rows by the zoom rule (year: `rank <= YEAR_CAP AND score IS NOT NULL`; month: `score IS NOT NULL AND (score >= HIGHLIGHT_THRESHOLD OR rank <= MIN_PER_GROUP)`; day: all), ordered `date_time DESC, id` for display. Reuse the album/people clause shape from `search.ts`. Treat `date_time IS NULL OR substr(date_time,1,4) NOT GLOB '[0-9][0-9][0-9][0-9]'` as undated.
- [ ] **Step 4: Register** `app.get('/timeline', timelineRoute)` and `app.get('/timeline/buckets', bucketsRoute)` in `worker/src/index.ts`.
- [ ] **Step 5: Run** `cd worker && npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(worker): /timeline and /timeline/buckets read routes`.

---

### Task 3: Proxy allowlist and API client

**Files:**
- Modify: `functions/api/[[path]].ts:24-34`, `src/services/api/WorkerApiClient.ts` (SearchParams at line 17, `searchPage` at line 88), `src/types/api.ts`
- Test: `src/services/api/__tests__/WorkerApiClient.test.ts` (extend if it exists, otherwise create beside the client following `src/services/__tests__` style)

**Interfaces:**
- Produces in `types/api.ts`: `TimelineZoom = 'year' | 'month' | 'day'`, `TimelineGroup`, `TimelineResponse`, `TimelineBucketsResponse` mirroring Task 2.
- Produces on `WorkerApiClient`: `getTimeline(p: { zoom: TimelineZoom; album?: string; people?: string[]; from?: string; to?: string; cursor?: string; groups?: number }): Promise<TimelineResponse>`; `getTimelineBuckets(p?: { album?: string; people?: string[] }): Promise<TimelineBucketsResponse>`; `SearchParams` gains `from?: string; to?: string; onThisDay?: string`, serialized by `searchPage`.

- [ ] **Step 1: Write failing tests**: `searchPage({ q:'x', from:'2025-06-01', to:'2025-06-30' })` requests a URL containing `from=2025-06-01&to=2025-06-30`; `getTimeline` and `getTimelineBuckets` build `/timeline?...` and `/timeline/buckets?...` with `people` comma-joined.
- [ ] **Step 2: Run** `npx vitest run src/services`. Expected: FAIL.
- [ ] **Step 3: Implement** the types, client methods and params; add `/^timeline$/` and `/^timeline\/buckets$/` to `ALLOWED_PATHS`.
- [ ] **Step 4: Run** `npm test && npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: proxy and client for timeline and date search`.

---

### Task 4: `parseDateQuery` and date range helpers

**Files:**
- Create: `src/services/dateQuery.ts`, `src/services/__tests__/dateQuery.test.ts`

**Interfaces:**
- Produces: `parseDateQuery(input: string): { text: string; from?: string; to?: string }` (extracts one date expression from free text and returns the remaining text trimmed); `quickRange(kind: 'today' | 'week' | 'month' | 'year', now?: Date): { from: string; to: string }` (week starts Monday); `onThisDayToday(now?: Date): string` returning `MM-DD`. All dates `YYYY-MM-DD`.

- [ ] **Step 1: Write failing tests** with fixed `now = 2026-11-06`: `parseDateQuery('beach 2025')` is `{ text:'beach', from:'2025-01-01', to:'2025-12-31' }`; `'june 2025'` and `'Jun 2025 beach'` give June 2025 (`to:'2025-06-30'`), `'feb 2024'` ends `2024-02-29`; `'2025-06-14'` gives a single day; `'sunset'` returns text only; `'2025 2024'` uses the first match and leaves the rest as text; `'room 1999x'` and `'12345'` are not dates (a bare year must be 1900..2100 and a whole word); `quickRange('week', now)` is `2026-11-02` to `2026-11-08`; `onThisDayToday` gives `11-06`.
- [ ] **Step 2: Run** `npx vitest run src/services/__tests__/dateQuery.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the three functions in `dateQuery.ts` (plain `Date`/regex, no new dependency; month names and 3-letter abbreviations, case-insensitive).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat: date query parsing helpers`.

---

### Task 5: Date controls in Search

**Files:**
- Modify: `package.json` (add `@mantine/dates` matching the installed Mantine 9 minor, and `dayjs`), `src/main.tsx` or `src/App.tsx` (import `@mantine/dates/styles.css` next to the other Mantine styles), `src/components/Search.tsx`
- Test: `src/components/__tests__/Search.test.tsx` (extend)

**Interfaces:**
- Consumes: `parseDateQuery`, `quickRange`, `onThisDayToday` (Task 4); `searchPage` params (Task 3).
- Produces: URL params `from`, `to`, `onThisDay` on `/search`; `hasCriteria` becomes true when any of them is set.

- [ ] **Step 1: Write failing tests**: with `?from=2025-06-01&to=2025-06-30` the query call includes both and the picker shows the range; clicking the "This month" chip sets `from`/`to` in the URL; clicking "On this day" sets `onThisDay` and clears `from`/`to` (and vice versa); submitting `june 2025 beach` sets `q=beach`, `from=2025-06-01`, `to=2025-06-30`; a date range alone (no text) triggers a search; clearing the picker removes both params.
- [ ] **Step 2: Run** `npx vitest run src/components/__tests__/Search.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** `npm install @mantine/dates dayjs`. Add `DatePickerInput type="range"` and a `Chip.Group` (Today, This week, This month, This year, On this day) to the Search card; include `from`, `to`, `onThisDay` in the react-query key and request; `submit` runs `parseDateQuery(text)` and updates `q`, `from`, `to` together with `resetPage`.
- [ ] **Step 4: Run** `npm test && npm run lint && npm run build`. Expected: PASS and a clean build.
- [ ] **Step 5: Commit** `feat: date range, quick chips and typed dates in Search`.

---

### Task 6: Timeline page

**Files:**
- Create: `src/components/Timeline.tsx`, `src/hooks/useTimelineParams.ts`, `src/components/__tests__/Timeline.test.tsx`, `src/hooks/__tests__/useTimelineParams.test.ts`
- Modify: `src/App.tsx:36` (route `/timeline`), `src/components/Layout.tsx:28` (nav item `Timeline` with a `react-icons/md` icon, placed after Albums), `src/components/__tests__/Layout.test.tsx`

**Interfaces:**
- Consumes: `workerApiClient.getTimeline` (Task 3), `PhotoGrid`.
- Produces: `useTimelineParams(): { zoom: TimelineZoom; album: string; people: string[]; to: string; setZoom(z: TimelineZoom): void; setFilters(patch): void; jumpTo(month: string): void }` backed by the URL (`zoom` omitted when `month`; `jumpTo('2025-03')` sets `to` to `2025-03-31`); `Timeline` default export.

- [ ] **Step 1: Write failing tests**: hook defaults to `month`, writes and reads `?zoom=day`, ignores an unknown zoom, `jumpTo('2025-02')` sets `to=2025-02-28`. Component: renders sticky headings like `November 2026` with "142 photos, 18 shown" from `total`/`shown`; a group with `shown: 0` says "N photos, zoom in to see"; day zoom headings read `Thu 6 Nov 2026`; Undated heading appears at day zoom; the Day/Month/Year segmented control changes `zoom` in the URL and refetches; Ctrl+wheel up on the grid steps toward Day and Ctrl+wheel down toward Year; "Load more" via an `IntersectionObserver` sentinel fetches the next cursor (stub the observer); empty result shows an empty state; album and people selects filter like Search.
- [ ] **Step 2: Run** `npx vitest run src/components/__tests__/Timeline.test.tsx src/hooks/__tests__/useTimelineParams.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `useTimelineParams`, then `Timeline` with `useInfiniteQuery` (key includes zoom, album, people, to; `getNextPageParam: p => p.nextCursor ?? undefined`), sticky headings per group using `PhotoGrid`, a `SegmentedControl` (Day, Month, Year), wheel (`ctrlKey`) and touch pinch handlers that call `setZoom` with a short debounce, and a bottom sentinel. Wire route and nav item.
- [ ] **Step 4: Run** `npm test && npm run lint && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: Timeline page with zoom levels`.

---

### Task 7: Scrubber rail

**Files:**
- Create: `src/components/TimelineScrubber.tsx`, `src/components/__tests__/TimelineScrubber.test.tsx`
- Modify: `src/components/Timeline.tsx` (mount it, pass the visible month)

**Interfaces:**
- Consumes: `workerApiClient.getTimelineBuckets` (Task 3), `jumpTo` (Task 6).
- Produces: `TimelineScrubber({ buckets, activeMonth, onJump }: { buckets: { month: string; total: number }[]; activeMonth: string | null; onJump(month: string): void })`, a fixed right-edge rail listing years with month ticks sized by count.

- [ ] **Step 1: Write failing tests**: renders a year label and a tick per month present (no tick for empty months); `activeMonth` marks its tick `aria-current`; click on a tick calls `onJump('2025-03')`; dragging pointer down the rail calls `onJump` for the month under the pointer, once per month change; renders nothing for an empty bucket list.
- [ ] **Step 2: Run** `npx vitest run src/components/__tests__/TimelineScrubber.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the component with pointer events; in `Timeline`, fetch buckets with `useQuery` (filtered by album/people), track `activeMonth` from the heading nearest the top (IntersectionObserver or scroll position), and on jump reset the feed with `to` set by `jumpTo`, scrolling to top.
- [ ] **Step 4: Run** `npm test && npm run lint && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: year and month scrubber for the timeline`.

---

### Task 8: Docs and end-to-end check

**Files:**
- Modify: `README.md`, `AGENTS.md` (Layout proxy allowlist line, add Timeline), `docs/architecture.md`, `docs/development.md` if it lists routes

- [ ] **Step 1:** Document the Timeline page, zoom levels, `/timeline` and `/timeline/buckets`, `from`/`to`/`onThisDay` on `/search`, the new `@mantine/dates` dependency, and the two new proxy patterns.
- [ ] **Step 2:** Run everything: `npm test && npm run lint && npm run build && (cd worker && npm test && npm run typecheck)`. Expected: all green.
- [ ] **Step 3:** Run `npm run dev` and use the `run` skill to confirm in the browser: Timeline loads, zoom toggle and Ctrl+scroll change density, scrubber jumps, Search date chips and `june 2025` typed shortcut work. Report anything not verified.
- [ ] **Step 4:** `graphify update .`, then commit `docs: timeline and date search` (include `.gitignore` and the spec/plan files if not yet committed).
