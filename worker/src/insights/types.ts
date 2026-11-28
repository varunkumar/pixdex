export type Topic = 'time' | 'gear' | 'wildlife' | 'people' | 'places';

/** One dashboard fact: `id` names it, `data` is typed per id. The frontend writes all text. */
export type Fact = never;

export type TopicBuilder = (db: D1Database, email: string, today: string) => Promise<Fact[]>;
