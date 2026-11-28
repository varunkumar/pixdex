import { COMBINED_SCORE_SQL } from '../db/rating';
import { CAMERA_OFFSET_MINUTES, ownedSql } from './common';

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

/**
 * The best photos of each window. json_each is the outer loop and `+photos.album` keeps the album index out, so
 * each window is one range of idx_photos_date_time (pinned in query-plans.test.ts). The dash test drops text such
 * as '2025:11:28', which sorts inside a window that crosses New Year. Binds the ranges (JSON), then the email.
 */
export const ON_THIS_DAY_SQL = `SELECT year, id FROM (
  SELECT year, id, ROW_NUMBER() OVER (PARTITION BY year ORDER BY score IS NULL, score DESC, date_time DESC, id) AS rn FROM (
    SELECT json_extract(r.value, '$.year') AS year, photos.id AS id, photos.date_time AS date_time, ${COMBINED_SCORE_SQL} AS score
    FROM json_each(?) AS r
    CROSS JOIN photos ON photos.date_time >= json_extract(r.value, '$.from') AND photos.date_time < json_extract(r.value, '$.to')
    WHERE substr(photos.date_time, 5, 1) = '-' AND ${ownedSql('+photos.album')}
  )
) WHERE rn <= ${ON_THIS_DAY_PER_YEAR} ORDER BY year DESC, rn`;

/** Photo ids for each earlier year with photos, newest year first. */
export async function onThisDayIds(db: D1Database, email: string, date: string): Promise<{ year: number; ids: string[] }[]> {
  const rows = await db.prepare(ON_THIS_DAY_SQL).bind(JSON.stringify(onThisDayRanges(date)), email).all<{ year: number; id: string }>();
  const years: { year: number; ids: string[] }[] = [];
  for (const row of rows.results) {
    if (years[years.length - 1]?.year !== row.year) years.push({ year: row.year, ids: [] });
    years[years.length - 1].ids.push(row.id);
  }
  return years;
}
