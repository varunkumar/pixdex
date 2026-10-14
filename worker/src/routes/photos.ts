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

interface AlbumRow {
  name: string;
  photo_count: number;
  cover_photo_id: string;
  content_hash: string | null;
  latest_date: string | null;
}

export async function getAlbumsRoute(c: Context<{ Bindings: Env }>) {
  // Lightweight list for dropdowns.
  if (c.req.query('names') === '1') {
    const result = await c.env.DB.prepare(
      'SELECT DISTINCT album FROM photos WHERE album IS NOT NULL ORDER BY album'
    ).all<{ album: string }>();
    return c.json({ albums: result.results.map((r) => r.album) });
  }

  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 12, 1), 48);
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);

  // Cover is the newest photo in the album: date_time, else last_indexed, ties by id.
  const [rows, count] = await Promise.all([
    c.env.DB.prepare(
      `WITH ranked AS (
         SELECT album, id, content_hash, date_time,
                COALESCE(date_time, last_indexed) AS ts,
                ROW_NUMBER() OVER (
                  PARTITION BY album ORDER BY COALESCE(date_time, last_indexed) DESC, id
                ) AS rn,
                COUNT(*) OVER (PARTITION BY album) AS cnt
         FROM photos
         WHERE album IS NOT NULL
       )
       SELECT album AS name, cnt AS photo_count, id AS cover_photo_id,
              content_hash, date_time AS latest_date
       FROM ranked
       WHERE rn = 1
       ORDER BY ts DESC, album
       LIMIT ? OFFSET ?`
    )
      .bind(limit, offset)
      .all<AlbumRow>(),
    c.env.DB.prepare('SELECT COUNT(DISTINCT album) AS total FROM photos WHERE album IS NOT NULL').first<{
      total: number;
    }>(),
  ]);

  return c.json({
    albums: rows.results.map((r) => ({
      name: r.name,
      photoCount: r.photo_count,
      coverPhotoId: r.cover_photo_id,
      coverThumbnailUrl: r.content_hash ? `/thumbnails/${r.content_hash}` : null,
      latestDate: r.latest_date ?? null,
    })),
    total: count?.total ?? 0,
  });
}
