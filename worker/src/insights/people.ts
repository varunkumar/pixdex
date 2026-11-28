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
 * One row for each set of the caller's people who share photos: how many photos show exactly that set, and the
 * newest believable day among them. Both facts come from these rows, so the faces are read once. Binds today, the
 * email, the email.
 */
export const PEOPLE_SQL = `SELECT people, COUNT(*) AS photos, MAX(day) AS last FROM (
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
) GROUP BY people`;

type SetRow = { people: string; photos: number; last: string | null };
type PeopleSet = { ids: string[]; photos: number; last: string | null };

const text = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The pairs with the most shared photos. A pair counts the photos of every set that holds both people. */
function together(sets: PeopleSet[]): Fact[] {
  const pairs = new Map<string, { a: string; b: string; photos: number }>();
  for (const { ids, photos } of sets) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = `${ids[i]}\n${ids[j]}`;
        const pair = pairs.get(key);
        if (pair) pair.photos += photos;
        else pairs.set(key, { a: ids[i], b: ids[j], photos });
      }
    }
  }
  const top = [...pairs.values()]
    .filter((p) => p.photos >= MIN_PAIR_PHOTOS)
    .sort((x, y) => y.photos - x.photos || text(x.a, y.a) || text(x.b, y.b))
    .slice(0, TOP_PAIRS);
  return top.length ? [{ id: 'together', data: { pairs: top } }] : [];
}

/** The person whose newest believable photo is the oldest, more than a year before `today`. */
function missed(sets: PeopleSet[], today: string): Fact[] {
  const people = new Map<string, { photos: number; last: string }>();
  for (const { ids, photos, last } of sets) {
    for (const id of ids) {
      const p = people.get(id) ?? { photos: 0, last: '' };
      p.photos += photos;
      if (last && last > p.last) p.last = last;
      people.set(id, p);
    }
  }
  const limit = new Date(Date.parse(`${today}T00:00:00Z`) - MISSED_DAYS * 86_400_000).toISOString().slice(0, 10);
  const found = [...people]
    .filter(([, p]) => p.photos >= MIN_MISSED_PHOTOS && p.last !== '' && p.last < limit)
    .sort((x, y) => text(x[1].last, y[1].last) || text(x[0], y[0]))[0];
  return found ? [{ id: 'missed', data: { person: found[0], lastDate: found[1].last, photos: found[1].photos } }] : [];
}

/**
 * One pass over the caller's named faces. No embedding is read; ids only, so names are resolved on each read. The
 * Worker handles one row for each set of people, not one for each photo.
 */
export const peopleFacts: TopicBuilder = async (db, email, today) => {
  const { results } = await db.prepare(PEOPLE_SQL).bind(today, email, email).all<SetRow>();
  const sets = results.map((r) => ({ ids: (JSON.parse(r.people) as string[]).sort(text), photos: r.photos, last: r.last }));
  return [...together(sets), ...missed(sets, today)];
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
