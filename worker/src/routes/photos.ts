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
  // The rich, paginated shape is opt-in (limit or offset present). A bare request
  // keeps the original list of names so an older cached frontend does not break.
  const wantsPage = c.req.query('limit') !== undefined || c.req.query('offset') !== undefined;
  if (c.req.query('names') === '1' || !wantsPage) {
    const result = await c.env.DB.prepare(
      'SELECT DISTINCT album FROM photos WHERE album IS NOT NULL ORDER BY album'
    ).all<{ album: string }>();
    return c.json({ albums: result.results.map((r) => r.album) });
  }

  const limit = Math.min(Math.max(Math.floor(Number(c.req.query('limit'))) || 12, 1), 48);
  const offset = Math.max(Math.floor(Number(c.req.query('offset'))) || 0, 0);

  // Cover: a dated photo when the album has one (newest first), else the most
  // recently indexed. latestDate and album order use the newest real photo date,
  // falling back to ingest time only for albums with no dated photo at all.
  const [rows, count] = await Promise.all([
    c.env.DB.prepare(
      `WITH ranked AS (
         SELECT album, id, content_hash, date_time,
                ROW_NUMBER() OVER (
                  PARTITION BY album
                  ORDER BY date_time IS NULL, date_time DESC, last_indexed DESC, id
                ) AS rn,
                COUNT(*) OVER (PARTITION BY album) AS cnt,
                MAX(date_time) OVER (PARTITION BY album) AS newest_date,
                MAX(last_indexed) OVER (PARTITION BY album) AS newest_indexed
         FROM photos
         WHERE album IS NOT NULL
       )
       SELECT album AS name, cnt AS photo_count, id AS cover_photo_id,
              content_hash, newest_date AS latest_date
       FROM ranked
       WHERE rn = 1
       ORDER BY COALESCE(newest_date, newest_indexed) DESC, album
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
