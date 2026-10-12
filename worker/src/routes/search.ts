import type { Context } from 'hono';
import type { Env } from '../types';
import { expandQuery, wildlifeSynonyms } from '../search/synonyms';
import { serializePhoto, type PhotoRow } from '../db/photos';

export async function searchRoute(c: Context<{ Bindings: Env }>) {
  const q = c.req.query('q');
  const album = c.req.query('album');
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 20, 1), 100);
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);

  const conditions: string[] = [];
  const params: unknown[] = [];
  let from: string;

  if (q) {
    from = `FROM photos JOIN photos_fts ON photos.rowid = photos_fts.rowid WHERE photos_fts MATCH ?`;
    params.push(expandQuery(q, wildlifeSynonyms));
  } else {
    from = `FROM photos WHERE 1=1`;
  }

  if (album) {
    conditions.push('album = ?');
    params.push(album);
  }

  if (conditions.length > 0) {
    from += ` AND ${conditions.join(' AND ')}`;
  }

  const [result, count] = await Promise.all([
    c.env.DB.prepare(`SELECT photos.* ${from} ORDER BY last_indexed DESC LIMIT ? OFFSET ?`)
      .bind(...params, limit, offset)
      .all<PhotoRow>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS total ${from}`)
      .bind(...params)
      .first<{ total: number }>(),
  ]);
  return c.json({ results: result.results.map(serializePhoto), total: count?.total ?? 0 });
}
