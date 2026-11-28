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

export type FocalGroup = 'under-35' | '35-69' | '70-199' | '200-399' | '400-plus';

export type GearFact =
  | { id: 'top-lens'; data: { lens: string; hits: number; photos: number; knownLensPhotos: number } }
  | { id: 'hit-rate'; data: { lenses: { lens: string; hits: number; photos: number }[] } }
  /** slot: the first hour of a 2-hour slot (0, 2, ... 22). */
  | { id: 'recipe'; data: { weekday: number; slot: number; focal: FocalGroup; hits: number; photos: number; allHits: number; allPhotos: number } }
  | { id: 'zoom'; data: { lens: string; min: number; max: number; atMax: number; photos: number; buckets: { from: number; to: number; photos: number }[] } }
  | { id: 'burst'; data: { years: { year: number; photos: number; moments: number }[] } }
  | { id: 'progress'; data: { years: { year: number; photos: number; hits: number; camera: string | null }[] } }
  | { id: 'cameras'; data: { total: number; cameras: { camera: string; first: string; last: string; photos: number }[] } };

export type WildlifeFact =
  /** byYear: the running species total at the end of each of the last years that added one. */
  | { id: 'life-list'; data: { total: number; year: number; newInYear: number; once: number; byYear: { year: number; total: number }[] } }
  /** month: 1 to 12. slots: the 2-hour slots within that month. */
  | { id: 'best-chance'; data: { species: string; photos: number; month: number; slot: number; slots: { slot: number; photos: number }[] } };

/** The cached shape holds person ids; the response replaces each with `{ id, name }` (hydrateFacts). */
export type PeopleFact =
  | { id: 'together'; data: { pairs: { a: string; b: string; photos: number }[] } }
  | { id: 'missed'; data: { person: string; lastDate: string; photos: number } };

export type PlacesFact =
  | { id: 'travel'; data: { km: number; place: string | null; date: string; gpsPhotos: number } }
  | { id: 'places'; data: { year: number; newCount: number; top: { place: string; days: number; photos: number }[]; gpsPhotos: number } };

/** One dashboard fact: `id` names it, `data` is typed per id. The frontend writes all text. */
export type Fact = TimeFact | GearFact | WildlifeFact | PeopleFact | PlacesFact;

export type TopicBuilder = (db: D1Database, email: string, today: string) => Promise<Fact[]>;
