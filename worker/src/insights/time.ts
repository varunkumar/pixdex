import { datedCte } from './common';
import type { Fact, TopicBuilder } from './types';

const MIN_DATED = 100;
const MIN_SHOOTING_DAYS = 10;
const MIN_YEAR_PHOTOS = 100;
const MIN_SHIFT_YEARS = 4;

const MONTHS_SQL = `${datedCte('id')}
SELECT CAST(strftime('%Y', t) AS INTEGER) AS y, CAST(strftime('%m', t) AS INTEGER) AS m, COUNT(*) AS n FROM d GROUP BY y, m ORDER BY y, m`;

const WEEKDAYS_SQL = `${datedCte('id')} SELECT CAST(strftime('%w', t) AS INTEGER) AS w, COUNT(*) AS n FROM d GROUP BY w`;

// MATERIALIZED: both result rows read the same days, so the photos are read once.
const RECORDS_SQL = `${datedCte('id')},
days AS MATERIALIZED (SELECT date(t) AS day, COUNT(*) AS n FROM d GROUP BY day),
gaps AS MATERIALIZED (SELECT day, n, LAG(day) OVER (ORDER BY day) AS prev, COUNT(*) OVER () AS total FROM days)
SELECT * FROM (SELECT 'busiest' AS kind, day, n, NULL AS prev, total FROM gaps ORDER BY n DESC, day DESC LIMIT 1)
UNION ALL
SELECT * FROM (SELECT 'gap', day, CAST(julianday(day) - julianday(prev) AS INTEGER), prev, total FROM gaps WHERE prev IS NOT NULL ORDER BY 3 DESC, day DESC LIMIT 1)`;

type MonthRow = { y: number; m: number; n: number };
type RecordRow = { kind: 'busiest' | 'gap'; day: string; n: number; prev: string | null; total: number };

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

/** Three passes over the owner's photos; the Worker handles at most a few hundred grouped rows. */
export const timeFacts: TopicBuilder = async (db, email, today) => {
  const [months, weekdays, records] = await Promise.all([
    db.prepare(MONTHS_SQL).bind(email, today).all<MonthRow>(),
    db.prepare(WEEKDAYS_SQL).bind(email, today).all<{ w: number; n: number }>(),
    db.prepare(RECORDS_SQL).bind(email, today).all<RecordRow>(),
  ]);
  const facts: Fact[] = [];
  const counts = monthCounts(months.results);
  const total = sum(counts);
  if (total >= MIN_DATED) {
    const week = new Array<number>(7).fill(0);
    for (const r of weekdays.results) week[r.w] = r.n;
    facts.push({ id: 'top-month', data: { counts, total } }, { id: 'top-weekday', data: { counts: week, total } });
  }
  const busiest = records.results.find((r) => r.kind === 'busiest');
  const gap = records.results.find((r) => r.kind === 'gap');
  if (busiest && gap && busiest.total >= MIN_SHOOTING_DAYS) {
    facts.push({
      id: 'records',
      data: { busiest: { date: busiest.day, count: busiest.n }, gap: { days: gap.n, from: gap.prev!, to: gap.day } },
    });
  }
  facts.push(...shift(months.results));
  return facts;
};
