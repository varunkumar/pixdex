import { PERSON_NAME_SQL, nameBinds } from '../db/faces';
import { CAMERA_OFFSET_MINUTES, ownedSql } from './common';
import type { Fact, TopicBuilder } from './types';

const MIN_PAIR_PHOTOS = 10;
const MIN_MISSED_PHOTOS = 20;
const MISSED_DAYS = 365;
const TOP_PAIRS = 3;

/**
 * The faces that count: shown (auto or confirmed, never ignored) faces of the caller's own people. Starting at
 * persons keeps the walk to named faces; `+` keeps the status and ignore tests from picking another face index.
 */
const OWN_FACES = `FROM persons p CROSS JOIN faces f ON f.person_id = p.id AND f.assign_status IN ('auto', 'confirmed')`;

/** Pairs of the caller's people by shared photos, from their owned albums. Binds the email three times. */
export const TOGETHER_SQL = `SELECT a, b, COUNT(DISTINCT photo) AS photos FROM (
  SELECT f.person_id AS a, g.person_id AS b, f.photo_id AS photo
  ${OWN_FACES}
  CROSS JOIN faces g ON g.photo_id = f.photo_id AND +g.person_id > f.person_id AND +g.assign_status IN ('auto', 'confirmed')
  CROSS JOIN persons q ON q.id = g.person_id AND q.owner_email = ?
  CROSS JOIN photos ph ON ph.id = f.photo_id
  WHERE p.owner_email = ? AND +f.ignored_at IS NULL AND +g.ignored_at IS NULL AND ${ownedSql('+ph.album')}
) GROUP BY a, b HAVING photos >= ${MIN_PAIR_PHOTOS} ORDER BY photos DESC, a, b LIMIT ${TOP_PAIRS}`;

/** The person whose newest believable photo is the oldest, over a year ago. Binds today, the email, the email, today. */
const MISSED_SQL = `SELECT person, photos, last FROM (
  SELECT person, COUNT(DISTINCT photo) AS photos, MAX(CASE WHEN t >= '1990-01-01' AND t < date(?, '+2 days') THEN date(t) END) AS last FROM (
    SELECT f.person_id AS person, ph.id AS photo, datetime(ph.date_time, '+${CAMERA_OFFSET_MINUTES} minutes') AS t
    ${OWN_FACES}
    CROSS JOIN photos ph ON ph.id = f.photo_id
    WHERE p.owner_email = ? AND +f.ignored_at IS NULL AND ${ownedSql('+ph.album')}
  ) GROUP BY person
) WHERE photos >= ${MIN_MISSED_PHOTOS} AND last < date(?, '-${MISSED_DAYS} days') ORDER BY last, person LIMIT 1`;

/** Two passes over the caller's named faces. No embedding is read; ids only, so names are resolved on each read. */
export const peopleFacts: TopicBuilder = async (db, email, today) => {
  const [pairs, missed] = await Promise.all([
    db.prepare(TOGETHER_SQL).bind(email, email, email).all<{ a: string; b: string; photos: number }>(),
    db.prepare(MISSED_SQL).bind(today, email, email, today).all<{ person: string; photos: number; last: string }>(),
  ]);
  const facts: Fact[] = [];
  if (pairs.results.length > 0) {
    facts.push({ id: 'together', data: { pairs: pairs.results.map(({ a, b, photos }) => ({ a, b, photos })) } });
  }
  const m = missed.results[0];
  if (m) facts.push({ id: 'missed', data: { person: m.person, lastDate: m.last, photos: m.photos } });
  return facts;
};

const NAMES_SQL = `SELECT p.id, ${PERSON_NAME_SQL} AS name FROM persons p
WHERE p.id IN (SELECT value FROM json_each(?)) AND p.owner_email = ?`;

/**
 * Replaces the cached person ids with `{ id, name }` as the caller may see them today. A person who was deleted,
 * or is no longer the caller's, drops out, and so does a fact left with nobody. No query without person facts.
 */
export async function hydrateFacts(db: D1Database, email: string, facts: Fact[]): Promise<unknown[]> {
  const ids = facts.flatMap((f) =>
    f.id === 'together' ? f.data.pairs.flatMap((p) => [p.a, p.b]) : f.id === 'missed' ? [f.data.person] : []
  );
  if (ids.length === 0) return facts;
  const rows = await db
    .prepare(NAMES_SQL)
    .bind(...nameBinds({ email }), JSON.stringify([...new Set(ids)]), email)
    .all<{ id: string; name: string }>();
  const people = new Map(rows.results.map((r) => [r.id, { id: r.id, name: r.name }]));
  return facts.flatMap((f): unknown[] => {
    if (f.id === 'together') {
      const pairs = f.data.pairs.flatMap(({ a, b, photos }) => {
        const [first, second] = [people.get(a), people.get(b)];
        return first && second ? [{ a: first, b: second, photos }] : [];
      });
      return pairs.length ? [{ id: f.id, data: { pairs } }] : [];
    }
    if (f.id === 'missed') {
      const person = people.get(f.data.person);
      return person ? [{ id: f.id, data: { ...f.data, person } }] : [];
    }
    return [f];
  });
}
