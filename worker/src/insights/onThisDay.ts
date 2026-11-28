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

/** The year, month and day of `date` (YYYY-MM-DD). 29 February counts as the 28th. */
function middle(date: string): [number, number, number] {
  const [year, month, day] = date.split('-').map(Number);
  return [year, month, month === 2 && day === 29 ? 28 : day];
}

/** One window of date ±2 days for each year before the year of `date`. */
export function onThisDayRanges(date: string): DayRange[] {
  const [year, month, day] = middle(date);
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

/**
 * One range for each earlier year that covers the windows of all of `dates`. The dates follow each other, so for each
 * calendar year the range runs from the window of its first date to the window of its last date. Only those two dates
 * need date texts.
 */
function blockRanges(dates: string[]): { from: string; to: string }[] {
  const ends = new Map<string, [string, string]>();
  for (const date of dates) {
    const year = date.slice(0, 4);
    ends.set(year, [ends.get(year)?.[0] ?? date, date]);
  }
  const all = [...ends.values()].flatMap(([first, last]) => {
    const [year, month, day] = middle(first);
    const [, lastMonth, lastDay] = middle(last);
    return Array.from({ length: year - FIRST_YEAR }, (_, i) => ({
      from: cameraMidnight(FIRST_YEAR + i, month, day, -ON_THIS_DAY_SPREAD),
      to: cameraMidnight(FIRST_YEAR + i, lastMonth, lastDay, ON_THIS_DAY_SPREAD + 1),
    }));
  });
  // Two calendar years in one block give ranges that can touch. Joined, SQLite reads each photo once.
  const out: { from: string; to: string }[] = [];
  for (const { from, to } of all.sort((a, b) => (a.from < b.from ? -1 : 1))) {
    const last = out[out.length - 1];
    if (last && from <= last.to) last.to = to > last.to ? to : last.to;
    else out.push({ from, to });
  }
  return out;
}

/** Days since 1970-01-01. */
const dayNumber = (year: number, month: number, day: number) => Date.UTC(year, month - 1, day) / DAY_MS;

/**
 * For each date of the block that starts on `start`: the photo ids of each earlier year with photos, newest year
 * first. The best 12 of a window are among the best 12 of its days, so one statement serves all seven dates. The
 * Worker handles at most 12 rows for each camera day (about 11 days for each year). It matches rows to windows by day
 * number, and only for the years near a returned row: date texts for every year and date cost too much CPU.
 */
export async function onThisDayBlock(db: D1Database, email: string, start: string): Promise<Record<string, YearIds[]>> {
  const dates = Array.from({ length: BLOCK_DAYS }, (_, i) => addDays(start, i));
  const rows = await db.prepare(ON_THIS_DAY_SQL).bind(JSON.stringify(blockRanges(dates)), email).all<{ day: string; id: string }>();
  // A window can cross New Year, so a photo can belong to the window year before or after its own year.
  const near = new Set<number>();
  for (const { day } of rows.results) {
    const year = Number(day.slice(0, 4));
    near.add(year - 1).add(year).add(year + 1);
  }
  const years = [...near].filter((y) => y >= FIRST_YEAR).sort((a, b) => b - a);
  // Day number to the lists (one for each date and year) that take the photos of that day.
  const takers = new Map<number, string[][]>();
  const lists = dates.map((date) => {
    const [dateYear, month, day] = middle(date);
    return {
      date,
      years: years
        .filter((year) => year < dateYear)
        .map((year) => {
          const ids: string[] = [];
          const centre = dayNumber(year, month, day);
          for (let n = centre - ON_THIS_DAY_SPREAD; n <= centre + ON_THIS_DAY_SPREAD; n++) {
            const known = takers.get(n);
            if (known) known.push(ids);
            else takers.set(n, [ids]);
          }
          return { year, ids };
        }),
    };
  });
  for (const { day, id } of rows.results) {
    const n = dayNumber(Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10)));
    for (const ids of takers.get(n) ?? []) if (ids.length < ON_THIS_DAY_PER_YEAR) ids.push(id);
  }
  return Object.fromEntries(lists.map(({ date, years }) => [date, years.filter((y) => y.ids.length > 0)]));
}

/** The photo ids of one date, calculated now. */
export async function onThisDayIds(db: D1Database, email: string, date: string): Promise<YearIds[]> {
  return (await onThisDayBlock(db, email, blockStart(date)))[date];
}
