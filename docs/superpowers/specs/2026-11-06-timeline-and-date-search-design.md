# Timeline view and date search

## Intent

Let the owner browse the collection by time, the way Google Photos does: a
scrollable timeline of highlights with a date scrubber, where zooming in reveals
more photos. Separately, let Search filter by date. Today the app can only list
photos by album, person or text, so "what did we do in June 2025?" has no good
path.

## Goals

- New **Timeline** page (nav tab). Photos grouped under sticky date headings,
  newest first, infinite scroll.
- **Highlights by default**: only better-rated photos, with zoom controlling how
  many are shown (see Zoom levels).
- **Right-edge scrubber** listing years and months; click or drag to jump;
  highlights the period currently in view.
- **Date search**: from/to range, quick chips, typed shortcuts, all combinable
  with the existing text, album and people filters.
- Same filters as Search where cheap: album and people.

## Non-goals

- No new ingest data, no agent changes, no D1 migration (`photos.date_time` is an
  ISO string and already indexed).
- No map view, no event/trip auto-clustering, no "memories" feature.
- Not replacing the Dashboard daily pick or the Albums pages.

## Anti-goals

- Never fetch the whole library to the browser to group it client side.
- Never expose tokens; no write routes added to the proxy.
- The highlights view must not look broken or empty for months with few rated
  photos.

## Design (decisions made with the owner marked [owner]; the rest are my calls)

### Layout [owner: Google Photos style, option A]

Grouped grid with sticky headings, e.g. "November 2026 - 142 photos, 18 shown"
(true total vs shown), and a thin year/month rail on the right. Reuses
`PhotoGrid` / `PhotoCard` and the existing lightbox. Photos with no
`date_time` go in an "Undated" group at the end, shown only at Day level.

### Zoom levels [owner: zooming in brings in more photos]

Three levels, like Google Photos' Day / Month / Year density toggle (my call on
the exact set):

| Level | Grouping | Rating cut-off | Cap per group |
|-------|----------|----------------|---------------|
| Year (zoomed out) | by month | highest | ~6 per month |
| Month (default) | by month | combined score >= threshold | none |
| Day (zoomed in) | by day | none (everything, incl. unrated) | none |

Controls (my call, mirrors Google Photos): a segmented Day / Month / Year toggle
in the toolbar, plus Ctrl+scroll and pinch on the grid stepping between levels.
Level is stored in the URL (`?zoom=year|month|day`).

Ranking uses `COMBINED_SCORE_SQL` from `worker/src/db/rating.ts`, never
`aesthetic_score` directly. Month-level threshold: a named constant (initial
guess 6.0 out of 10, tune against real data). Unrated photos (null combined
score) appear only at Day level.

Calls made on the open questions (my calls):

- **Sparse months never go empty.** At Year and Month level each group shows
  photos clearing the threshold, but at least the top 3 scored photos of that
  month (`MIN_PER_GROUP`, a named constant) when it has that many scored photos.
  A month with only unrated photos shows none until Day level, and its heading
  says "N photos, zoom in to see". Suggested query: `ROW_NUMBER() OVER
  (PARTITION BY month ORDER BY combined_score DESC)` and keep rows where
  `score >= threshold OR rank <= MIN_PER_GROUP`.
- **Year level** takes the top ~6 by score per month (rank <= 6), ignoring the
  threshold. **Display order inside every group is date descending**, whatever
  was used to select the photos. Groups are paged by cursor on the group key
  (month or day), so Year and Month share one query path.
- **Undated** photos form a single "Undated" group, shown at Day level only (the
  most inclusive level). They never appear at Year or Month level.

### Worker API (read-only)

- `GET /search` gains `from` and `to` (ISO dates, inclusive, validated; bad
  values return 400). Filter is `photos.date_time >= ? AND photos.date_time < ?`
  (`to` is exclusive of the next day).
- `GET /timeline` (new): same album/people filters plus `zoom`, `from`, `to`,
  `limit`, `cursor`. Returns photos in date-descending order, with each group's
  `{ key, total, shown }`. Cursor paging, not offset.
- `GET /timeline/buckets` (new): true photo counts per month (the client derives
  years) over the library or the album/people-filtered set, for the scrubber.
  Independent of zoom and of the rating cut-off, so the scrubber always lists
  every month that has photos. Small payload. Day level uses the same month
  buckets for the scrubber.
- The Timeline page has no date-range control of its own. `from`/`to` on
  `/timeline` exist so a scrubber jump to an old month can start the feed there:
  the client sets `to` to the end of that month and pages onward from it.
- Both new routes are added to the Pages proxy `ALLOWED_PATHS` as GET only.
  `/ingest/*` stays out.
- All user input is bound, never interpolated.

### Date search UI

In Search: a date-range picker (Mantine dates) and chips: Today, This week, This
month, This year, On this day (same month/day in past years). Typed shortcuts in
the search box are parsed client side into a range and removed from the text
query: `2025`, `june 2025`, `2025-06-14`. Range lives in the URL as `from`/`to`.
"Last summer" and other fuzzy phrases are dropped (ambiguous). "On this day" is
not a range: it is a separate `onThisDay=MM-DD` param and `/search` filter
(`substr(date_time, 6, 5) = ?`), mutually exclusive with `from`/`to`. A pure `parseDateQuery()` function holds the parsing so it is
unit tested.

### Docs and hygiene

Update `README.md`, `AGENTS.md` (layout and proxy allowlist lines) and
`docs/architecture.md` in the same commit. Add `.superpowers/` to `.gitignore`.
Tests first for Worker routes and `parseDateQuery`; frontend tests for zoom
state and grouping. Run `npm test`, `cd worker && npm test && npm run typecheck`,
`npm run lint`. Do not bypass the pre-commit hook.

## Left to the builder

- Exact infinite-scroll mechanics (react-query infinite query, virtualization if
  needed for thousands of photos).
- Scrubber drag implementation and visual polish.
- Tuning the month-level threshold and the year-level per-month cap.
- Whether `/timeline` and `/search` share one query builder.
- Timezone handling for day grouping (suggest grouping on the stored ISO date
  prefix). Correction after review: that prefix is the UTC date, not the
  camera's own date, because the agent stores `toISOString()` of the EXIF local
  time. Photos near midnight can land on the neighbouring day; see the
  limitation note in `docs/architecture.md`.
