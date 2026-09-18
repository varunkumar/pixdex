import type { Context } from 'hono';
import type { Env } from '../types';
import { expandQuery, wildlifeSynonyms } from '../search/synonyms';

interface PhotoRow {
  id: string;
  content_hash: string;
  filename: string;
  subjects: string;
  colors: string;
  patterns: string;
  tags: string;
  suggested_hashtags: string;
  [key: string]: unknown;
}

function parseRow(row: PhotoRow) {
  return {
    ...row,
    subjects: JSON.parse(row.subjects),
    colors: JSON.parse(row.colors),
    patterns: JSON.parse(row.patterns),
    tags: JSON.parse(row.tags),
    suggestedHashtags: JSON.parse(row.suggested_hashtags),
    thumbnailUrl: `/thumbnails/${row.content_hash}`,
  };
}

export async function searchRoute(c: Context<{ Bindings: Env }>) {
  const q = c.req.query('q');
  const album = c.req.query('album');
  const limit = Math.min(Number(c.req.query('limit') ?? '20'), 100);
  const offset = Number(c.req.query('offset') ?? '0');

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
  return c.json({ results: result.results.map(parseRow) });
}
