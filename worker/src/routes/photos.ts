import type { Context } from 'hono';
import { z } from 'zod';
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
  avg_score: number | null;
}

// Whitelisted ORDER BY clauses; the sort query param never reaches SQL directly.
const ALBUM_ORDER: Record<string, string> = {
  date: 'COALESCE(newest_date, newest_indexed) DESC, album',
  name: 'album COLLATE NOCASE, album',
  count: 'cnt DESC, album COLLATE NOCASE',
  rating: 'avg_score IS NULL, avg_score DESC, album COLLATE NOCASE',
};

const coverBody = z.object({ album: z.string().min(1), photoId: z.string().min(1) });

export async function putAlbumCoverRoute(c: Context<{ Bindings: Env }>) {
  const parsed = coverBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'album and photoId are required' }, 400);
  const { album, photoId } = parsed.data;

  const photo = await c.env.DB.prepare('SELECT album FROM photos WHERE id = ?')
    .bind(photoId)
    .first<{ album: string | null }>();
  if (!photo || photo.album !== album) return c.json({ error: 'Photo is not in this album' }, 400);

  await c.env.DB.prepare(
    `INSERT INTO album_covers (album, photo_id) VALUES (?, ?)
     ON CONFLICT(album) DO UPDATE SET photo_id = excluded.photo_id`
  )
    .bind(album, photoId)
    .run();
  return c.json({ album, photoId });
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

  const orderBy = ALBUM_ORDER[c.req.query('sort') ?? ''] ?? ALBUM_ORDER.date;
  const only = c.req.query('name');
  const filter = only ? 'AND album = ?' : '';
  const filterParams = only ? [only] : [];

  // Cover: the photo picked for the album if it is still in it, else a dated photo
  // when the album has one (newest first), else the most recently indexed.
  // latestDate and the default order use the newest real photo date, falling back
  // to ingest time only for albums with no dated photo at all.
  const [rows, count] = await Promise.all([
    c.env.DB.prepare(
      `WITH ranked AS (
         SELECT album, id, content_hash, date_time,
                ROW_NUMBER() OVER (
                  PARTITION BY album
                  ORDER BY (id = (SELECT photo_id FROM album_covers WHERE album_covers.album = photos.album)) DESC,
                           date_time IS NULL, date_time DESC, last_indexed DESC, id
                ) AS rn,
                AVG(aesthetic_score) OVER (PARTITION BY album) AS avg_score,
                COUNT(*) OVER (PARTITION BY album) AS cnt,
                MAX(date_time) OVER (PARTITION BY album) AS newest_date,
                MAX(last_indexed) OVER (PARTITION BY album) AS newest_indexed
         FROM photos
         WHERE album IS NOT NULL ${filter}
       )
       SELECT album AS name, cnt AS photo_count, id AS cover_photo_id,
              content_hash, newest_date AS latest_date, avg_score
       FROM ranked
       WHERE rn = 1
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`
    )
      .bind(...filterParams, limit, offset)
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
