import type { Context } from 'hono';
import type { Env } from '../types';
import { COMBINED_SCORE_SQL } from '../db/rating';
import { dateFilterSql, parseDateFilter } from '../db/dateFilter';
import { serializePhoto, type PhotoRow } from '../db/photos';

// Highlight rule for the zoomed-out views: a photo is shown when its combined
// score reaches the threshold, and every group tops up to the best MIN_PER_GROUP
// rated photos. Year zoom is a flat cap per month instead.
export const HIGHLIGHT_THRESHOLD = 6.0;
export const MIN_PER_GROUP = 3;
export const YEAR_CAP = 6;

const DEFAULT_GROUPS = 6;
const MAX_GROUPS = 24;

const DATED = `(photos.date_time IS NOT NULL AND substr(photos.date_time, 1, 4) GLOB '[0-9][0-9][0-9][0-9]')`;

// Shared album/people filters, same shape as /search. All values are bound.
function scopeSql(album: string | undefined, people: string[]) {
  let sql = '';
  const params: unknown[] = [];
  if (album) {
    sql += ` AND photos.album = ?`;
    params.push(album);
  }
  if (people.length > 0) {
    sql += ` AND photos.id IN (SELECT photo_id FROM faces WHERE person_id IN (${people.map(() => '?').join(',')}) AND assign_status IN ('auto','confirmed') GROUP BY photo_id HAVING COUNT(DISTINCT person_id) = ?)`;
    params.push(...people, people.length);
  }
  return { sql, params };
}

function parsePeople(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    ),
  ].slice(0, 5);
}

export async function timelineRoute(c: Context<{ Bindings: Env }>) {
  const zoom = c.req.query('zoom') ?? 'month';
  if (zoom !== 'year' && zoom !== 'month' && zoom !== 'day') {
    return c.json({ error: 'zoom must be year, month or day' }, 400);
  }
  const groupsRaw = c.req.query('groups');
  let perPage = DEFAULT_GROUPS;
  if (groupsRaw !== undefined && groupsRaw !== '') {
    perPage = Number(groupsRaw);
    if (!Number.isInteger(perPage) || perPage < 1 || perPage > MAX_GROUPS) {
      return c.json({ error: `groups must be an integer from 1 to ${MAX_GROUPS}` }, 400);
    }
  }
  const parsedDates = parseDateFilter((name) => c.req.query(name));
  if (!parsedDates.ok) return c.json({ error: parsedDates.error }, 400);
  const cursor = c.req.query('cursor') || undefined;

  const scope = scopeSql(c.req.query('album'), parsePeople(c.req.query('people')));
  const dates = dateFilterSql(parsedDates.filter);

  const keyExpr =
    zoom === 'day'
      ? `CASE WHEN ${DATED} THEN substr(photos.date_time, 1, 10) ELSE 'undated' END`
      : `substr(photos.date_time, 1, 7)`;
  // Year and month zoom only show dated photos; undated ones live at day zoom.
  const where = `WHERE 1=1${zoom === 'day' ? '' : ` AND ${DATED}`}${scope.sql}${dates.sql}`;
  const whereParams = [...scope.params, ...dates.params];

  // Pass 1: the next page of group keys with their full totals.
  if (cursor === 'undated') return c.json({ groups: [], nextCursor: null });
  const keyParams: unknown[] = [...whereParams];
  let keyset = '';
  if (cursor) {
    keyset = ` AND (${keyExpr} = 'undated' OR ${keyExpr} < ?)`;
    keyParams.push(cursor);
  }
  const keyRows = await c.env.DB.prepare(
    `SELECT ${keyExpr} AS k, COUNT(*) AS total FROM photos ${where}${keyset}
     GROUP BY k ORDER BY k = 'undated', k DESC LIMIT ?`
  )
    .bind(...keyParams, perPage + 1)
    .all<{ k: string; total: number }>();
  const pageKeys = keyRows.results.slice(0, perPage);
  const nextCursor = keyRows.results.length > perPage ? pageKeys[pageKeys.length - 1].k : null;
  if (pageKeys.length === 0) return c.json({ groups: [], nextCursor: null });

  // Pass 2: ranked photos for those keys, trimmed by the zoom rule.
  const keep =
    zoom === 'day'
      ? '1=1'
      : zoom === 'year'
        ? `score IS NOT NULL AND rnk <= ${YEAR_CAP}`
        : `score IS NOT NULL AND (score >= ${HIGHLIGHT_THRESHOLD} OR rnk <= ${MIN_PER_GROUP})`;
  const photoRows = await c.env.DB.prepare(
    `WITH scored AS (
       SELECT photos.*, ${keyExpr} AS gk, ${COMBINED_SCORE_SQL} AS score FROM photos ${where}
     ), ranked AS (
       SELECT scored.*, ROW_NUMBER() OVER (
         PARTITION BY gk ORDER BY score IS NULL, score DESC, date_time DESC, id
       ) AS rnk FROM scored WHERE gk IN (${pageKeys.map(() => '?').join(',')})
     )
     SELECT * FROM ranked WHERE ${keep} ORDER BY date_time DESC, id`
  )
    .bind(...whereParams, ...pageKeys.map((g) => g.k))
    .all<PhotoRow & { gk: string }>();

  const byKey = new Map<string, ReturnType<typeof serializePhoto>[]>();
  for (const row of photoRows.results) {
    const list = byKey.get(row.gk) ?? [];
    list.push(serializePhoto(row));
    byKey.set(row.gk, list);
  }
  const groups = pageKeys.map((g) => {
    const photos = byKey.get(g.k) ?? [];
    return { key: g.k, total: g.total, shown: photos.length, photos };
  });
  return c.json({ groups, nextCursor });
}

export async function bucketsRoute(c: Context<{ Bindings: Env }>) {
  const scope = scopeSql(c.req.query('album'), parsePeople(c.req.query('people')));
  const rows = await c.env.DB.prepare(
    `SELECT CASE WHEN ${DATED} THEN substr(photos.date_time, 1, 7) ELSE NULL END AS month, COUNT(*) AS total
     FROM photos WHERE 1=1${scope.sql} GROUP BY month ORDER BY month DESC`
  )
    .bind(...scope.params)
    .all<{ month: string | null; total: number }>();
  const buckets = rows.results.filter((r) => r.month !== null).map((r) => ({ month: r.month as string, total: r.total }));
  const undated = rows.results.find((r) => r.month === null)?.total ?? 0;
  return c.json({ buckets, undated });
}
