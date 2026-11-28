import { COMBINED_SCORE_SQL } from '../db/rating';
import { CAMERA_OFFSET_MINUTES } from './common';

export const ON_THIS_DAY_SPREAD = 2;
export const ON_THIS_DAY_PER_YEAR = 12;
const FIRST_YEAR = 1990;

export interface DayRange {
  /** The year of the middle date, which labels the window. */
  year: number;
  /** Inclusive and exclusive `date_time` bounds (UTC, as stored). */
  from: string;
  to: string;
}

/** The UTC instant of camera midnight `days` after (year, month, day), without a zone suffix. */
const cameraMidnight = (year: number, month: number, day: number, days: number) =>
  new Date(Date.UTC(year, month - 1, day + days) - CAMERA_OFFSET_MINUTES * 60_000).toISOString().slice(0, 19);

/** One window of date ±2 days for each year before the year of `date` (YYYY-MM-DD). 29 February counts as the 28th. */
export function onThisDayRanges(date: string): DayRange[] {
  const [year, month, rawDay] = date.split('-').map(Number);
  const day = month === 2 && rawDay === 29 ? 28 : rawDay;
  const ranges: DayRange[] = [];
  for (let y = FIRST_YEAR; y < year; y++) {
    ranges.push({
      year: y,
      from: cameraMidnight(y, month, day, -ON_THIS_DAY_SPREAD),
      to: cameraMidnight(y, month, day, ON_THIS_DAY_SPREAD + 1),
    });
  }
  return ranges;
}

export const BLOCK_DAYS = 7;
const DAY_MS = 86_400_000;
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** The first date of the 7-day block that holds `date`. One calculation serves the whole block. */
export function blockStart(date: string): string {
  const day = Date.parse(`${date}T00:00:00Z`) / DAY_MS;
  return addDays(date, -(((day % BLOCK_DAYS) + BLOCK_DAYS) % BLOCK_DAYS));
}

/**
 * The 12 best photos of each camera day inside the ranges, in rank order, from the caller's albums only. The caller's
 * albums are the outer loop, then the ranges, so each (album, range) pair is one range of the (album, date_time)
 * index and no other user's photo is read (pinned in query-plans.test.ts and insights-isolation.test.ts). It costs
 * one albums row for each owned album and range. The dash test drops text such as '2025:11:28', which sorts inside a
 * range that crosses New Year. Binds the ranges (JSON), then the email.
 */
export const ON_THIS_DAY_SQL = `SELECT day, id FROM (
  SELECT day, id, date_time, score,
    ROW_NUMBER() OVER (PARTITION BY day ORDER BY score IS NULL, score DESC, date_time DESC, id) AS rn FROM (
    SELECT date(photos.date_time, '+${CAMERA_OFFSET_MINUTES} minutes') AS day, photos.id AS id, photos.date_time AS date_time,
      ${COMBINED_SCORE_SQL} AS score
    FROM albums AS a
    CROSS JOIN json_each(?) AS r
    CROSS JOIN photos ON photos.album = a.name
      AND photos.date_time >= json_extract(r.value, '$.from') AND photos.date_time < json_extract(r.value, '$.to')
    WHERE a.owner_email = ? AND substr(photos.date_time, 5, 1) = '-'
  )
) WHERE rn <= ${ON_THIS_DAY_PER_YEAR} ORDER BY score IS NULL, score DESC, date_time DESC, id`;

export type YearIds = { year: number; ids: string[] };

/** Overlapping windows joined, so that SQLite reads each photo once. */
function joined(windows: DayRange[]): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (const { from, to } of [...windows].sort((a, b) => (a.from < b.from ? -1 : 1))) {
    const last = out[out.length - 1];
    if (last && from <= last.to) last.to = to > last.to ? to : last.to;
    else out.push({ from, to });
  }
  return out;
}

/** The camera date on which a window starts. */
const firstDay = (from: string) => new Date(Date.parse(`${from}Z`) + CAMERA_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);

/**
 * For each date of the block that starts on `start`: the photo ids of each earlier year with photos, newest year
 * first. The best 12 of a window are among the best 12 of its days, so one statement serves all seven dates. The
 * Worker handles at most 12 rows for each camera day (about 11 days for each year).
 */
export async function onThisDayBlock(db: D1Database, email: string, start: string): Promise<Record<string, YearIds[]>> {
  const dates = Array.from({ length: BLOCK_DAYS }, (_, i) => addDays(start, i));
  const windows = dates.map((date) => ({ date, ranges: onThisDayRanges(date) }));
  // Camera day to the lists (one for each date and year) that take its photos.
  const takers = new Map<string, string[][]>();
  const lists = windows.map(({ date, ranges }) => ({
    date,
    years: ranges.map(({ year, from }) => {
      const ids: string[] = [];
      const first = firstDay(from);
      for (let i = 0; i <= 2 * ON_THIS_DAY_SPREAD; i++) {
        const day = addDays(first, i);
        const known = takers.get(day);
        if (known) known.push(ids);
        else takers.set(day, [ids]);
      }
      return { year, ids };
    }),
  }));
  const rows = await db
    .prepare(ON_THIS_DAY_SQL)
    .bind(JSON.stringify(joined(windows.flatMap((w) => w.ranges))), email)
    .all<{ day: string; id: string }>();
  for (const { day, id } of rows.results) {
    for (const ids of takers.get(day) ?? []) if (ids.length < ON_THIS_DAY_PER_YEAR) ids.push(id);
  }
  return Object.fromEntries(lists.map(({ date, years }) => [date, years.filter((y) => y.ids.length > 0).reverse()]));
}

/** The photo ids of one date, calculated now. */
export async function onThisDayIds(db: D1Database, email: string, date: string): Promise<YearIds[]> {
  return (await onThisDayBlock(db, email, blockStart(date)))[date];
}
