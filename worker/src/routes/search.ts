import type { Context } from 'hono';
import type { Env } from '../types';
import { expandQueryTiers } from '../search/synonyms';
import { COMBINED_SCORE_SQL } from '../db/rating';
import { dateFilterSql, parseDateFilter } from '../db/dateFilter';
import { userOf } from '../access';
import { canEditFor, scopeForRequest } from '../db/visibility';
import { serializePhoto, type PhotoRow } from '../db/photos';

export async function searchRoute(c: Context<{ Bindings: Env }>) {
  const q = c.req.query('q');
  const album = c.req.query('album');
  const sort = c.req.query('sort');
  // "Together": photos with a visible face for every listed person. Deduped and
  // capped at 5 ids; ids are always bound, never interpolated.
  const people = [
    ...new Set(
      (c.req.query('people') ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    ),
  ].slice(0, 5);
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 20, 1), 100);
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);

  const parsedDates = parseDateFilter((name) => c.req.query(name));
  if (!parsedDates.ok) return c.json({ error: parsedDates.error }, 400);
  const dates = dateFilterSql(parsedDates.filter);

  const user = userOf(c);
  // Computed once per request and reused by every query (including the COUNT).
  const access = await scopeForRequest(c.env.DB, user, 'photos.album');
  const canEdit = await canEditFor(c.env.DB, user, access);

  async function run(match: string | null) {
    const params: unknown[] = [];
    let from: string;
    if (match) {
      from = `FROM photos JOIN photos_fts ON photos.rowid = photos_fts.rowid WHERE photos_fts MATCH ?`;
      params.push(match);
    } else {
      from = `FROM photos WHERE 1=1`;
    }
    if (album) {
      from += ` AND album = ?`;
      params.push(album);
    }
    from += access.sql;
    params.push(...access.params);
    from += dates.sql;
    params.push(...dates.params);
    if (people.length > 0) {
      from += ` AND photos.id IN (SELECT photo_id FROM faces WHERE person_id IN (${people.map(() => '?').join(',')}) AND assign_status IN ('auto','confirmed') GROUP BY photo_id HAVING COUNT(DISTINCT person_id) = ?)`;
      params.push(...people, people.length);
    }

    // Album pages sort by date (newest first), name (file name) or rating (best first).
    // Otherwise best text match first; newest indexed first among equals and when
    // there is no query.
    const order =
      sort === 'date'
        ? `ORDER BY photos.date_time DESC, last_indexed DESC`
        : sort === 'name'
          ? `ORDER BY filename COLLATE NOCASE, photos.id`
          : sort === 'rating'
            ? `ORDER BY ${COMBINED_SCORE_SQL} IS NULL, ${COMBINED_SCORE_SQL} DESC, photos.date_time DESC, photos.id`
            : match
              ? `ORDER BY bm25(photos_fts, 1.0, 4.0), last_indexed DESC`
              : `ORDER BY last_indexed DESC`;
    const unfiltered = !match && !album && !dates.sql && people.length === 0 && access.sql === '';
    const [rows, count] = await Promise.all([
      c.env.DB.prepare(`SELECT photos.* ${from} ${order} LIMIT ? OFFSET ?`)
        .bind(...params, limit, offset)
        .all<PhotoRow>(),
      // No filter at all: the trigger-maintained counter instead of counting every photo.
      unfiltered
        ? c.env.DB.prepare("SELECT n AS total FROM counters WHERE name = 'photos'").first<{ total: number }>()
        : c.env.DB.prepare(`SELECT COUNT(*) AS total ${from}`)
            .bind(...params)
            .first<{ total: number }>(),
    ]);
    return { results: rows.results.map((r) => serializePhoto(r, canEdit(r.album))), total: count?.total ?? 0 };
  }

  if (!q) return c.json(await run(null));

  // Try the strictest reading first and loosen only while nothing matches
  // (see expandQueryTiers); the last tier is any word, ranked by bm25.
  const tiers = expandQueryTiers(q);
  let response = await run(tiers[0] ?? null);
  for (const tier of tiers.slice(1)) {
    if (response.total > 0) break;
    response = await run(tier);
  }
  return c.json(response);
}
