import type { Context } from 'hono';
import * as z from 'zod/mini';
import type { Env } from '../types';
import { userOf } from '../access';
import { canEditFor, scopeForRequest, visibleAlbumsSql } from '../db/visibility';
import { primaryTextForRow, serializePhoto, searchTextForRow, type PhotoRow } from '../db/photos';

export async function getPhotoRoute(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id');
  const user = userOf(c);
  const access = await scopeForRequest(c.env.DB, user, 'album');
  const row = await c.env.DB.prepare(`SELECT * FROM photos WHERE id = ?${access.sql}`)
    .bind(id, ...access.params)
    .first<PhotoRow>();
  if (!row) {
    return c.text('Not Found', 404);
  }
  const canEdit = await canEditFor(c.env.DB, user, access);
  return c.json(serializePhoto(row, canEdit(row.album)));
}

interface AlbumRow {
  name: string;
  photo_count: number;
  cover_photo_id: string;
  content_hash: string | null;
  latest_date: string | null;
  owner_email: string | null;
  shared_with: string | null;
}

// Whitelisted ORDER BY clauses; the sort query param never reaches SQL directly.
const ALBUM_ORDER: Record<string, string> = {
  date: 'COALESCE(latest_date, newest_indexed) DESC, name',
  name: 'name COLLATE NOCASE, name',
  count: 'photo_count DESC, name COLLATE NOCASE',
  rating: 'avg_score IS NULL, avg_score DESC, name COLLATE NOCASE',
};

const tagList = z.array(z.string().check(z.trim(), z.minLength(1), z.maxLength(60))).check(z.maxLength(30));

// Every field is optional; an omitted one is left alone and null (or empty) clears the override.
const reviewBody = z
  .partial(
    z.object({
      userRating: z.nullable(z.int().check(z.minimum(1), z.maximum(5))),
      caption: z.nullable(z.string().check(z.trim(), z.maxLength(80))),
      subjects: z.nullable(tagList),
      tags: z.nullable(tagList),
    }),
  )
  .check(z.refine((v) => Object.keys(v).length > 0, { error: 'nothing to update' }));

const coverBody = z.object({ album: z.string().check(z.minLength(1)), photoId: z.string().check(z.minLength(1)) });

function parseShared(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const dedupe = (items: string[]) => [...new Map(items.map((i) => [i.toLowerCase(), i])).values()];

/** Human review of one photo: star rating and overrides for title, subjects and tags. */
export async function patchPhotoRoute(c: Context<{ Bindings: Env }>) {
  const parsed = reviewBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: z.flattenError(parsed.error) }, 400);
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
  return c.json(serializePhoto(row, true));
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
  const user = userOf(c);
  // Empty scope (default owner, no album has an owner): no predicate, the original queries.
  const open = (await scopeForRequest(c.env.DB, user, 'album')).sql === '';
  const v = visibleAlbumsSql(user);
  const filter = open ? { where: '', and: '', params: [] as unknown[] } : { where: ` WHERE name IN ${v.sql}`, and: ` AND name IN ${v.sql}`, params: v.params };
  const wantsPage = c.req.query('limit') !== undefined || c.req.query('offset') !== undefined;
  if (c.req.query('names') === '1' || !wantsPage) {
    const result = await c.env.DB.prepare(`SELECT name FROM albums${filter.where} ORDER BY name`)
      .bind(...filter.params)
      .all<{ name: string }>();
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
      `SELECT name, photo_count, cover_photo_id, content_hash, latest_date, owner_email, shared_with FROM albums
       ${only ? 'WHERE name = ?' : ''}${only ? filter.and : filter.where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`
    )
      .bind(...(only ? [only] : []), ...filter.params, limit, offset)
      .all<AlbumRow>(),
    // Counts every visible album, not just a filtered one.
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM albums${filter.where}`)
      .bind(...filter.params)
      .first<{ total: number }>(),
  ]);

  return c.json({
    albums: rows.results.map((r) => {
      const owns = user.isDefaultOwner ? r.owner_email === null || r.owner_email === user.email : r.owner_email === user.email;
      return {
        name: r.name,
        photoCount: r.photo_count,
        coverPhotoId: r.cover_photo_id,
        coverThumbnailUrl: r.content_hash ? `/thumbnails/${r.content_hash}` : null,
        latestDate: r.latest_date ?? null,
        role: owns ? ('owner' as const) : ('viewer' as const),
        ...(owns ? { sharedWith: parseShared(r.shared_with) } : {}),
      };
    }),
    total: totalRow?.total ?? 0,
  });
}
