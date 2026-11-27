# Manual data updates

One-off fixes to the production D1 database that no screen or agent command covers.
Run every command from `worker/`. These write to live data: look first, write second,
read back last. Do not put real album names, people or emails in this file; use
placeholders.

## Rules

- Prefer a UI action or an agent command when one exists.
- Select the target rows first and note their current values, so the change can be undone.
- Match exactly (`album = '...'`), not with `LIKE`, in the `UPDATE`. Double any single
  quote inside a value (`'Asha''s album'`).
- Never write `albums` or `counters`: triggers derive them from `photos`. The owner
  columns on `albums` have their own routes and script (see `AGENTS.md`).
- Never write `user_*` columns, `faces.person_id`, `faces.assign_status` or
  `faces.ignored_at` by hand: those are owner decisions made in the UI.
- Do not hand-edit columns that feed search (`subjects`, `tags`, captions, species):
  `search_text` and `search_primary` are built by the Worker and would go stale.
- For a large or destructive change, take a Time Travel bookmark first
  (`npx wrangler d1 time-travel info DB`).
- Check `rows_read` and `rows_written` in the `--json` output.

## Set the date of an album that has none

For photos whose files carry no capture date (exports, edited PNGs, scans).

### Which value to store

`photos.date_time` is an ISO 8601 UTC string, for example `2022-07-07T04:03:25.000Z`.
Date search and "On this day" compare that stored UTC string
(`worker/src/db/dateFilter.ts`), while the browser shows the date in the viewer's
time zone. For 29 Aug 2021:

| Meaning | Stored value | Shown in IST | Date search and "On this day" |
| --- | --- | --- | --- |
| Midnight IST | `2021-08-28T18:30:00.000Z` | 29 Aug | 28 Aug |
| Midnight UTC (05:30 IST) | `2021-08-29T00:00:00.000Z` | 29 Aug | 29 Aug |

Use midnight UTC when only the day matters. Use midnight IST only if that exact instant
is wanted.

### Steps

1. Look at the album (`LIKE` is fine here; it scans the whole `photos` table once):

   ```bash
   npx wrangler d1 execute DB --remote --json --command \
     "SELECT album, COUNT(*) AS photos, COUNT(date_time) AS dated, MIN(date_time), MAX(date_time)
      FROM photos WHERE album LIKE '%<part of name>%' GROUP BY album"
   ```

2. Fill in the missing dates only:

   ```bash
   npx wrangler d1 execute DB --remote --json --command \
     "UPDATE photos SET date_time = '2021-08-29T00:00:00.000Z'
      WHERE album = '<album name>' AND date_time IS NULL
      RETURNING id, filename, date_time"
   ```

   Keep the returned ids: they are the rows to undo.

3. Read back, including the derived album date:

   ```bash
   npx wrangler d1 execute DB --remote --json --command \
     "SELECT p.id, p.filename, p.date_time, a.latest_date FROM photos p
      JOIN albums a ON a.name = p.album WHERE p.album = '<album name>'"
   ```

To undo, set `date_time = NULL` for the ids returned in step 2.

A later re-index that posts the same photo id to `POST /ingest/photo` replaces
`date_time` with what the agent read from the file, so check the dates again after
re-indexing that album.

Cost seen on a 3-photo album: 43 rows read and 18 written (the triggers refresh the
album row and the search index).
