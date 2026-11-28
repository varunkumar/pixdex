import { datedCte } from './common';
import type { Fact, TopicBuilder } from './types';

const MIN_DATED = 100;
const MIN_SHOOTING_DAYS = 10;
const MIN_YEAR_PHOTOS = 100;
const MIN_SHIFT_YEARS = 4;

/**
 * One row holding `[[day, photos], ...]`. Every time fact comes from the shooting days, so the photos are read
 * once; separate statements for the records read about six times as many rows.
 */
const DAYS_SQL = `${datedCte('id')}
SELECT json_group_array(json_array(day, n)) AS days FROM (SELECT date(t) AS day, COUNT(*) AS n FROM d GROUP BY day)`;

type MonthRow = { y: number; m: number; n: number };
type Day = [day: string, photos: number];

/** The day with the most photos, and the longest step between two shooting days (a later day wins a tie). */
function records(days: Day[]): Fact[] {
  if (days.length < MIN_SHOOTING_DAYS) return [];
  let busiest = days[0];
  let gap = { days: 0, from: '', to: '' };
  for (let i = 1; i < days.length; i++) {
    if (days[i][1] >= busiest[1]) busiest = days[i];
    const apart = (Date.parse(days[i][0]) - Date.parse(days[i - 1][0])) / 86_400_000;
    if (apart >= gap.days) gap = { days: apart, from: days[i - 1][0], to: days[i][0] };
  }
  return [{ id: 'records', data: { busiest: { date: busiest[0], count: busiest[1] }, gap } }];
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

function monthCounts(rows: MonthRow[]): number[] {
  const counts = new Array<number>(12).fill(0);
  for (const r of rows) counts[r.m - 1] += r.n;
  return counts;
}

/** The peak month of the older half of the busy years against the newer half; nothing when they are the same. */
function shift(rows: MonthRow[]): Fact[] {
  const perYear = new Map<number, number>();
  for (const r of rows) perYear.set(r.y, (perYear.get(r.y) ?? 0) + r.n);
  const years = [...perYear].filter(([, n]) => n >= MIN_YEAR_PHOTOS).map(([y]) => y);
  if (years.length < MIN_SHIFT_YEARS) return [];
  const half = Math.floor(years.length / 2);
  const describe = (span: number[]) => {
    const counts = monthCounts(rows.filter((r) => span.includes(r.y)));
    return { from: span[0], to: span[span.length - 1], month: counts.indexOf(Math.max(...counts)) + 1 };
  };
  const older = describe(years.slice(0, half));
  const newer = describe(years.slice(half));
  return older.month === newer.month ? [] : [{ id: 'shifts', data: { older, newer } }];
}

/** One pass over the owner's photos; the Worker walks the shooting days (a few thousand at most). */
export const timeFacts: TopicBuilder = async (db, email, today) => {
  const row = await db.prepare(DAYS_SQL).bind(email, today).first<{ days: string }>();
  const days = (JSON.parse(row?.days ?? '[]') as Day[]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const months: MonthRow[] = [];
  const week = new Array<number>(7).fill(0);
  for (const [day, n] of days) {
    const date = new Date(day);
    const [y, m] = [date.getUTCFullYear(), date.getUTCMonth() + 1];
    week[date.getUTCDay()] += n;
    const last = months[months.length - 1];
    if (last?.y === y && last.m === m) last.n += n;
    else months.push({ y, m, n });
  }
  const facts: Fact[] = [];
  const counts = monthCounts(months);
  const total = sum(counts);
  if (total >= MIN_DATED) {
    facts.push({ id: 'top-month', data: { counts, total } }, { id: 'top-weekday', data: { counts: week, total } });
  }
  facts.push(...records(days), ...shift(months));
  return facts;
};
