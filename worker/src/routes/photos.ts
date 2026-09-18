import type { Context } from 'hono';
import type { Env } from '../types';
import { serializePhoto, type PhotoRow } from '../db/photos';

export async function getPhotoRoute(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT * FROM photos WHERE id = ?').bind(id).first<PhotoRow>();
  if (!row) {
    return c.text('Not Found', 404);
  }
  return c.json(serializePhoto(row));
}

export async function getAlbumsRoute(c: Context<{ Bindings: Env }>) {
  const result = await c.env.DB.prepare(
    'SELECT DISTINCT album FROM photos WHERE album IS NOT NULL ORDER BY album'
  ).all<{ album: string }>();
  return c.json({ albums: result.results.map((r) => r.album) });
}
