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

/**
 * `s` has one row for each set of the caller's people who share photos: how many photos show exactly that set, and
 * the newest believable day among them. Both facts come from `s`, so the faces are read once. The result is at most
 * 3 pair rows (`b` is set) and 1 person row (`b` is NULL), so the Worker does no grouping. Binds today, the email,
 * the email, today.
 */
export const PEOPLE_SQL = `WITH s AS MATERIALIZED (
  SELECT people, COUNT(*) AS photos, MAX(day) AS last FROM (
    SELECT x.people AS people,
      (SELECT date(t) FROM (SELECT datetime(ph.date_time, '+${CAMERA_OFFSET_MINUTES} minutes') AS t) WHERE t >= '1990-01-01' AND t < date(?, '+2 days')) AS day
    FROM (
      SELECT f.photo_id AS photo, json_group_array(DISTINCT f.person_id) AS people
      ${OWN_FACES}
      WHERE p.owner_email = ? AND +f.ignored_at IS NULL
      GROUP BY f.photo_id
    ) AS x
    CROSS JOIN photos ph ON ph.id = x.photo
    WHERE ${ownedSql('+ph.album')}
  ) GROUP BY people
)
SELECT * FROM (
  SELECT m.value AS a, n.value AS b, SUM(s.photos) AS photos, NULL AS last
  FROM s CROSS JOIN json_each(s.people) AS m CROSS JOIN json_each(s.people) AS n ON n.value > m.value
  GROUP BY m.value, n.value HAVING SUM(s.photos) >= ${MIN_PAIR_PHOTOS} ORDER BY photos DESC, a, b LIMIT ${TOP_PAIRS}
)
UNION ALL
SELECT * FROM (
  SELECT m.value AS a, NULL AS b, SUM(s.photos) AS photos, MAX(s.last) AS last
  FROM s CROSS JOIN json_each(s.people) AS m
  GROUP BY m.value HAVING SUM(s.photos) >= ${MIN_MISSED_PHOTOS} AND MAX(s.last) < date(?, '-${MISSED_DAYS} days')
  ORDER BY last, a LIMIT 1
)`;

type Row = { a: string; b: string | null; photos: number; last: string | null };

/** One pass over the caller's named faces. No embedding is read; ids only, so names are resolved on each read. */
export const peopleFacts: TopicBuilder = async (db, email, today) => {
  const { results } = await db.prepare(PEOPLE_SQL).bind(today, email, email, today).all<Row>();
  const pairs = results.flatMap(({ a, b, photos }) => (b === null ? [] : [{ a, b, photos }]));
  const facts: Fact[] = pairs.length ? [{ id: 'together', data: { pairs } }] : [];
  const m = results.find((r) => r.b === null);
  if (m) facts.push({ id: 'missed', data: { person: m.a, lastDate: m.last!, photos: m.photos } });
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
