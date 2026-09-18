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
  let sql: string;

  if (q) {
    sql = `SELECT photos.* FROM photos JOIN photos_fts ON photos.rowid = photos_fts.rowid WHERE photos_fts MATCH ?`;
    params.push(expandQuery(q, wildlifeSynonyms));
  } else {
    sql = `SELECT * FROM photos WHERE 1=1`;
  }

  if (album) {
    conditions.push('album = ?');
    params.push(album);
  }

  if (conditions.length > 0) {
    sql += ` AND ${conditions.join(' AND ')}`;
  }

  sql += ` ORDER BY last_indexed DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const result = await c.env.DB.prepare(sql).bind(...params).all<PhotoRow>();
  return c.json({ results: result.results.map(serializePhoto) });
}
