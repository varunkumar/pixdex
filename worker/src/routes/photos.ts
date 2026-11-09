import type { Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { primaryTextForRow, serializePhoto, searchTextForRow, type PhotoRow } from '../db/photos';

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

// Whitelisted ORDER BY clauses; the sort query param never reaches SQL directly.
const ALBUM_ORDER: Record<string, string> = {
  date: 'COALESCE(latest_date, newest_indexed) DESC, name',
  name: 'name COLLATE NOCASE, name',
  count: 'photo_count DESC, name COLLATE NOCASE',
  rating: 'avg_score IS NULL, avg_score DESC, name COLLATE NOCASE',
};

const tagList = z.array(z.string().trim().min(1).max(60)).max(30);

// Every field is optional; an omitted one is left alone and null (or empty) clears the override.
const reviewBody = z
  .object({
    userRating: z.number().int().min(1).max(5).nullable(),
    caption: z.string().trim().max(80).nullable(),
    subjects: tagList.nullable(),
    tags: tagList.nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' });

const coverBody = z.object({ album: z.string().min(1), photoId: z.string().min(1) });

const dedupe = (items: string[]) => [...new Map(items.map((i) => [i.toLowerCase(), i])).values()];

/** Human review of one photo: star rating and overrides for title, subjects and tags. */
export async function patchPhotoRoute(c: Context<{ Bindings: Env }>) {
  const parsed = reviewBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const edit = parsed.data;

  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT * FROM photos WHERE id = ?').bind(id).first<PhotoRow>();
  if (!row) return c.text('Not Found', 404);

  if ('userRating' in edit) row.user_rating = edit.userRating ?? null;
  if ('caption' in edit) row.user_caption = edit.caption || null;
  if ('subjects' in edit) row.user_subjects = edit.subjects?.length ? JSON.stringify(dedupe(edit.subjects)) : null;
  if ('tags' in edit) row.user_tags = edit.tags?.length ? JSON.stringify(dedupe(edit.tags)) : null;

  // search_text is rebuilt so a corrected species stops matching the model's wrong one.
  row.search_text = searchTextForRow(row);
  row.search_primary = primaryTextForRow(row);
  await c.env.DB.prepare(
    `UPDATE photos SET user_rating = ?, user_caption = ?, user_subjects = ?, user_tags = ?, search_text = ?, search_primary = ?
     WHERE id = ?`
  )
    .bind(row.user_rating ?? null, row.user_caption ?? null, row.user_subjects ?? null, row.user_tags ?? null, row.search_text, row.search_primary, id)
    .run();
  return c.json(serializePhoto(row));
}

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
    const result = await c.env.DB.prepare('SELECT name FROM albums ORDER BY name').all<{ name: string }>();
    return c.json({ albums: result.results.map((r) => r.name) });
  }

  const limit = Math.min(Math.max(Math.floor(Number(c.req.query('limit'))) || 12, 1), 48);
  const offset = Math.max(Math.floor(Number(c.req.query('offset'))) || 0, 0);

  const orderBy = ALBUM_ORDER[c.req.query('sort') ?? ''] ?? ALBUM_ORDER.date;
  const only = c.req.query('name');

  // The `albums` table is maintained by triggers (migration 0015): cover, newest date and average score
  // are already worked out per album, so a page reads at most one row per album and never touches photos.
  const [rows, totalRow] = await Promise.all([
    c.env.DB.prepare(
      `SELECT name, photo_count, cover_photo_id, content_hash, latest_date FROM albums
       ${only ? 'WHERE name = ?' : ''} ORDER BY ${orderBy} LIMIT ? OFFSET ?`
    )
      .bind(...(only ? [only] : []), limit, offset)
      .all<AlbumRow>(),
    // Counts every album, not just a filtered one.
    c.env.DB.prepare('SELECT COUNT(*) AS total FROM albums').first<{ total: number }>(),
  ]);

  return c.json({
    albums: rows.results.map((r) => ({
      name: r.name,
      photoCount: r.photo_count,
      coverPhotoId: r.cover_photo_id,
      coverThumbnailUrl: r.content_hash ? `/thumbnails/${r.content_hash}` : null,
      latestDate: r.latest_date ?? null,
    })),
    total: totalRow?.total ?? 0,
  });
}
