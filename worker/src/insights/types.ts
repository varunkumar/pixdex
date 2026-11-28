export type Topic = 'time' | 'gear' | 'wildlife' | 'people' | 'places';

/** A span of years and its busiest month (1 to 12). */
export interface YearSpan {
  from: number;
  to: number;
  month: number;
}

export type TimeFact =
  /** counts: 12 months, index 0 is January. */
  | { id: 'top-month'; data: { counts: number[]; total: number } }
  /** counts: 7 weekdays, index 0 is Sunday. */
  | { id: 'top-weekday'; data: { counts: number[]; total: number } }
  | { id: 'records'; data: { busiest: { date: string; count: number }; gap: { days: number; from: string; to: string } } }
  | { id: 'shifts'; data: { older: YearSpan; newer: YearSpan } };

/** One dashboard fact: `id` names it, `data` is typed per id. The frontend writes all text. */
export type Fact = TimeFact;

export type TopicBuilder = (db: D1Database, email: string, today: string) => Promise<Fact[]>;
