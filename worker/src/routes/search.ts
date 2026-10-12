import type { Context } from 'hono';
import type { Env } from '../types';
import { expandQuery, wildlifeSynonyms } from '../search/synonyms';
import { serializePhoto, type PhotoRow } from '../db/photos';

export async function searchRoute(c: Context<{ Bindings: Env }>) {
  const q = c.req.query('q');
  const album = c.req.query('album');
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 20, 1), 100);
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);

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

    // Best text match first; newest first among equals and when there is no query.
    const order = match ? `ORDER BY bm25(photos_fts), last_indexed DESC` : `ORDER BY last_indexed DESC`;
    const [rows, count] = await Promise.all([
      c.env.DB.prepare(`SELECT photos.* ${from} ${order} LIMIT ? OFFSET ?`)
        .bind(...params, limit, offset)
        .all<PhotoRow>(),
      c.env.DB.prepare(`SELECT COUNT(*) AS total ${from}`)
        .bind(...params)
        .first<{ total: number }>(),
    ]);
    return { results: rows.results.map(serializePhoto), total: count?.total ?? 0 };
  }

  if (!q) return c.json(await run(null));

  // Every meaningful word must match; if that finds nothing, fall back to any word.
  const strict = expandQuery(q, wildlifeSynonyms, 'all');
  let response = await run(strict);
  if (response.total === 0) {
    const loose = expandQuery(q, wildlifeSynonyms, 'any');
    if (loose !== strict) response = await run(loose);
  }
  return c.json(response);
}
