import type { Context } from 'hono';
import * as z from 'zod/mini';
import type { Env } from '../types';
import { primaryTextForRow, searchTextForRow, speciesListSchema, speciesModelSchema, type PhotoRow } from '../db/photos';

const MAX_PHOTOS = 100;

/** The rows to rebuild, by the unique content_hash index (a plan test checks it). */
export const SPECIES_ROWS_BY_HASH_SQL = 'SELECT * FROM photos WHERE content_hash IN (SELECT value FROM json_each(?))';

const requestSchema = z.object({
  model: speciesModelSchema,
  photos: z
    .array(z.object({ contentHash: z.string().check(z.minLength(1)), species: speciesListSchema }))
    .check(z.minLength(1), z.maxLength(MAX_PHOTOS)),
});

/**
 * Sets the species the agent found on already-indexed photos, keyed by content hash, so existing
 * photos can be updated without a re-index. Sending an empty list records "scanned, nothing found"
 * (species_model is set), which is what keeps the backfill from scanning the photo again.
 *
 * Cost per request (at most 100 photos): one SELECT of those rows by the unique content_hash index,
 * one batched UPDATE per known photo (the FTS triggers rewrite that photo's index row). The search
 * text is rebuilt from the row, so repeating a request or replacing species never piles up words.
 * The owner's own subjects win: with user_subjects set the species are stored but not indexed.
 */
export async function ingestSpeciesRoute(c: Context<{ Bindings: Env }>) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: z.flattenError(parsed.error) }, 400);
  const { model, photos } = parsed.data;

  // The last entry wins when a hash is repeated in one request.
  const byHash = new Map(photos.map((p) => [p.contentHash, p.species]));
  const rows = await c.env.DB.prepare(SPECIES_ROWS_BY_HASH_SQL)
    .bind(JSON.stringify([...byHash.keys()]))
    .all<PhotoRow>();

  const update = c.env.DB.prepare('UPDATE photos SET species = ?, species_model = ?, search_text = ?, search_primary = ? WHERE id = ?');
  const statements = rows.results.map((row) => {
    row.species = JSON.stringify(byHash.get(row.content_hash as string) ?? []);
    row.species_model = model;
    return update.bind(row.species, model, searchTextForRow(row), primaryTextForRow(row), row.id);
  });
  if (statements.length > 0) await c.env.DB.batch(statements);

  return c.json({ updated: statements.length, unknown: byHash.size - statements.length });
}

const pendingSchema = z.object({
  model: speciesModelSchema,
  cursor: z.optional(z.int().check(z.minimum(0))),
  limit: z.int().check(z.minimum(1), z.maximum(MAX_PHOTOS)),
  album: z.optional(z.string().check(z.minLength(1))),
});

// A photo the agent can open: a local file by path or a Google Drive file by id.
const OPENABLE = `((source = 'local' AND path IS NOT NULL) OR (source = 'google_drive' AND drive_file_id IS NOT NULL))`;

export const pendingSpeciesSql = (albumClause = '') =>
  `SELECT rowid AS cursor, content_hash, source, path, drive_file_id, album, filename, latitude, longitude, subjects
     FROM photos
     WHERE ${OPENABLE} AND (species_model IS NULL OR species_model != ?) AND rowid > ?${albumClause}
     ORDER BY rowid LIMIT ?`;

/**
 * Photos still to scan for species, so a backfill follows the index (D1) instead of folders and
 * covers local and Google Drive photos alike. A photo is pending until species_model equals the
 * agent's model (an empty species list still sets it), so a re-run only does what is left and a
 * new model re-scans everything. Paged by rowid, at most 100 per page; `album` limits it to one
 * album. Rows read: the scan walks rowids from the cursor until it has a page, so one full pass
 * reads each photo row about once. Rows written: 0.
 */
export async function pendingSpeciesRoute(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json().catch(() => undefined);
  if (body === undefined) return c.json({ error: 'Invalid JSON body' }, 400);
  const parsed = pendingSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: z.flattenError(parsed.error) }, 400);
  const { model, cursor = 0, limit, album } = parsed.data;

  const params: (string | number)[] = [model, cursor];
  let albumClause = '';
  if (album) {
    albumClause = ' AND album = ?';
    params.push(album);
  }
  params.push(limit);

  const { results } = await c.env.DB.prepare(pendingSpeciesSql(albumClause))
    .bind(...params)
    .all<{ cursor: number; content_hash: string; source: string; path: string | null; drive_file_id: string | null; album: string | null; filename: string; latitude: number | null; longitude: number | null; subjects: string }>();

  return c.json({
    items: results.map((r) => ({
      contentHash: r.content_hash,
      source: r.source,
      path: r.path,
      driveFileId: r.drive_file_id,
      album: r.album,
      filename: r.filename,
      latitude: r.latitude,
      longitude: r.longitude,
      subjects: safeStrings(r.subjects),
    })),
    nextCursor: results.length === limit ? results[results.length - 1].cursor : null,
  });
}

function safeStrings(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const summarySchema = z.object({ model: speciesModelSchema });

/**
 * Per album: how many photos there are and how many still need a species scan with this model
 * (only photos the agent can open count as pending). One pass over photos, for the occasional
 * `backfill-species --list`; rows written: 0.
 */
export async function speciesSummaryRoute(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json().catch(() => undefined);
  if (body === undefined) return c.json({ error: 'Invalid JSON body' }, 400);
  const parsed = summarySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: z.flattenError(parsed.error) }, 400);

  const { results } = await c.env.DB.prepare(
    `SELECT album, COUNT(*) AS total,
            SUM(CASE WHEN ${OPENABLE} AND (species_model IS NULL OR species_model != ?) THEN 1 ELSE 0 END) AS pending
     FROM photos GROUP BY album ORDER BY album`
  )
    .bind(parsed.data.model)
    .all<{ album: string | null; total: number; pending: number }>();
  return c.json({ albums: results });
}
