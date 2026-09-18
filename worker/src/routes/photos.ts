import type { Context } from 'hono';
import type { Env } from '../types';

interface PhotoRow {
  subjects: string;
  colors: string;
  patterns: string;
  tags: string;
  suggested_hashtags: string;
  content_hash: string;
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

export async function getPhotoRoute(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT * FROM photos WHERE id = ?').bind(id).first<PhotoRow>();
  if (!row) {
    return c.text('Not Found', 404);
  }
  return c.json(parseRow(row));
}

export async function getAlbumsRoute(c: Context<{ Bindings: Env }>) {
  const result = await c.env.DB.prepare(
    'SELECT DISTINCT album FROM photos WHERE album IS NOT NULL ORDER BY album'
  ).all<{ album: string }>();
  return c.json({ albums: result.results.map((r) => r.album) });
}
