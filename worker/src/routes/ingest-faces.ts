import type { Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { embeddingFromBase64, embeddingToBytes } from '../people/embedding';
import { autoMatchFaces } from '../people/autoMatch';

type Box = { x: number; y: number; w: number; h: number };

const unscannedSchema = z.object({
  model: z.string().min(1),
  cursor: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(500).default(200),
  pathPrefix: z.string().min(1).max(1024).optional(),
  // Also list photos already scanned with this model that have a face without a sharp crop.
  missingCrops: z.boolean().optional(),
});

const pendingSchema = z.object({
  hashes: z.array(z.string().min(1)).max(5000),
  model: z.string().min(1),
});

export const MAX_FACES_PER_REQUEST = 10;

const unit = z.number().min(0).max(1);
const faceSchema = z.object({
  bbox: z.object({ x: unit, y: unit, w: unit, h: unit }),
  detScore: z.number().min(0).max(1),
  embedding: z.string().min(1),
  // Base64 JPEG of a padded square crop (about 192 px, well under 100 KB); optional for older agents.
  crop: z.string().max(150_000).optional(),
});

// z.object strips unknown keys, so person_id / assign_status in a body are dropped.
const facesSchema = z.object({
  contentHash: z.string().min(1),
  model: z.string().min(1),
  // D1's free tier allows ~50 queries per invocation and each stored face is one INSERT,
  // so a request carries at most MAX_FACES_PER_REQUEST faces. The agent keeps the largest.
  faces: z.array(faceSchema).max(MAX_FACES_PER_REQUEST),
});

function iou(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

const cropKey = (faceId: string) => `faces/${faceId}.jpg`;

function cropFromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function putCrop(c: Context<{ Bindings: Env }>, faceId: string, bytes: Uint8Array) {
  await c.env.THUMBNAILS.put(cropKey(faceId), bytes, { httpMetadata: { contentType: 'image/jpeg' } });
}

async function readJson(c: Context<{ Bindings: Env }>): Promise<unknown | undefined> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/** Hashes that are indexed but not yet face-scanned with this model. */
export async function pendingFacesRoute(c: Context<{ Bindings: Env }>) {
  const body = await readJson(c);
  if (body === undefined) return c.json({ error: 'Invalid JSON body' }, 400);
  const parsed = pendingSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { hashes, model } = parsed.data;
  if (hashes.length === 0) return c.json({ pending: [] });

  const { results } = await c.env.DB.prepare(
    `SELECT content_hash FROM photos
     WHERE content_hash IN (SELECT value FROM json_each(?))
       AND (faces_scanned_model IS NULL OR faces_scanned_model != ?)`
  )
    .bind(JSON.stringify(hashes), model)
    .all<{ content_hash: string }>();
  const pending = new Set(results.map((r) => r.content_hash));
  // Preserve request order and drop duplicates.
  return c.json({ pending: [...new Set(hashes)].filter((h) => pending.has(h)) });
}

/**
 * Local photos that are indexed but not yet face-scanned with this model, with the
 * path the agent indexed them from, so a backfill follows the index instead of
 * walking folders. Paged by rowid; `pathPrefix` limits it to one folder.
 */
export async function unscannedFacesRoute(c: Context<{ Bindings: Env }>) {
  const body = await readJson(c);
  if (body === undefined) return c.json({ error: 'Invalid JSON body' }, 400);
  const parsed = unscannedSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { model, cursor = 0, limit, pathPrefix, missingCrops } = parsed.data;

  const missingCropsClause = missingCrops
    ? ' OR EXISTS (SELECT 1 FROM faces f WHERE f.photo_id = photos.id AND f.crop_key IS NULL)'
    : '';
  const params: (string | number)[] = [model, cursor];
  let prefixClause = '';
  if (pathPrefix) {
    // Escape LIKE wildcards so a folder name containing % or _ matches literally.
    prefixClause = ` AND path LIKE ? ESCAPE '\\'`;
    params.push(`${pathPrefix.replace(/[\\%_]/g, '\\$&')}%`);
  }
  params.push(limit);

  const { results } = await c.env.DB.prepare(
    `SELECT rowid AS cursor, content_hash, path FROM photos
     WHERE source = 'local' AND path IS NOT NULL
       AND (faces_scanned_model IS NULL OR faces_scanned_model != ?${missingCropsClause})
       AND rowid > ?${prefixClause}
     ORDER BY rowid LIMIT ?`
  )
    .bind(...params)
    .all<{ cursor: number; content_hash: string; path: string }>();

  return c.json({
    items: results.map((r) => ({ contentHash: r.content_hash, path: r.path })),
    nextCursor: results.length === limit ? results[results.length - 1].cursor : null,
  });
}

/**
 * Replaces a photo's unassigned and auto faces with a fresh scan. Confirmed
 * faces are owner data: they are kept, and any new face overlapping one
 * (IoU >= 0.5) is dropped as a duplicate.
 */
export async function ingestFacesRoute(c: Context<{ Bindings: Env }>) {
  const body = await readJson(c);
  if (body === undefined) return c.json({ error: 'Invalid JSON body' }, 400);
  const parsed = facesSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { contentHash, model, faces } = parsed.data;

  let blobs: Uint8Array[];
  let crops: (Uint8Array | undefined)[];
  try {
    blobs = faces.map((f) => embeddingToBytes(embeddingFromBase64(f.embedding)));
    crops = faces.map((f) => (f.crop ? cropFromBase64(f.crop) : undefined));
  } catch {
    return c.json({ error: 'Invalid embedding or crop' }, 400);
  }

  const photo = await c.env.DB.prepare('SELECT id FROM photos WHERE content_hash = ?')
    .bind(contentHash)
    .first<{ id: string }>();
  if (!photo) return c.json({ error: 'Unknown content hash' }, 404);

  const confirmed = await c.env.DB.prepare(
    "SELECT id, bbox_x, bbox_y, bbox_w, bbox_h FROM faces WHERE photo_id = ? AND assign_status = 'confirmed'"
  )
    .bind(photo.id)
    .all<{ id: string; bbox_x: number; bbox_y: number; bbox_w: number; bbox_h: number }>();
  const confirmedBoxes: (Box & { id: string })[] = confirmed.results.map((r) => ({ id: r.id, x: r.bbox_x, y: r.bbox_y, w: r.bbox_w, h: r.bbox_h }));

  // Rejections are keyed by face id, and a re-scan replaces the unassigned/auto rows with new ids.
  // Carry each rejection over to the new face that overlaps its old box (IoU >= 0.5).
  const rejections = await c.env.DB.prepare(
    `SELECT r.face_id, r.person_id, f.bbox_x, f.bbox_y, f.bbox_w, f.bbox_h
     FROM face_rejections r JOIN faces f ON f.id = r.face_id
     WHERE f.photo_id = ? AND f.assign_status IN ('unassigned', 'auto')`
  )
    .bind(photo.id)
    .all<{ face_id: string; person_id: string; bbox_x: number; bbox_y: number; bbox_w: number; bbox_h: number }>();

  // Crops of the faces about to be replaced go away with them.
  const stale = await c.env.DB.prepare(
    "SELECT crop_key FROM faces WHERE photo_id = ? AND assign_status IN ('unassigned', 'auto') AND crop_key IS NOT NULL"
  )
    .bind(photo.id)
    .all<{ crop_key: string }>();

  const now = new Date().toISOString();
  const statements = [
    c.env.DB.prepare(
      `DELETE FROM face_rejections WHERE face_id IN
         (SELECT id FROM faces WHERE photo_id = ? AND assign_status IN ('unassigned', 'auto'))`
    ).bind(photo.id),
    c.env.DB.prepare("DELETE FROM faces WHERE photo_id = ? AND assign_status IN ('unassigned', 'auto')").bind(photo.id),
  ];
  let stored = 0;
  let kept = 0;
  const newIds: string[] = [];
  const cropWrites: Promise<unknown>[] = [];
  const carried: { f: string; p: string }[] = [];
  faces.forEach((f, i) => {
    const duplicate = confirmedBoxes.find((b) => iou(b, f.bbox) >= 0.5);
    if (duplicate) {
      kept++;
      // The owner's face keeps its data; a fresh sharp crop still replaces its old image.
      const crop = crops[i];
      if (crop) {
        cropWrites.push(putCrop(c, duplicate.id, crop));
        statements.push(
          c.env.DB.prepare('UPDATE faces SET crop_key = ? WHERE id = ?').bind(cropKey(duplicate.id), duplicate.id)
        );
      }
      return;
    }
    stored++;
    const faceId = crypto.randomUUID();
    newIds.push(faceId);
    for (const r of rejections.results) {
      if (iou({ x: r.bbox_x, y: r.bbox_y, w: r.bbox_w, h: r.bbox_h }, f.bbox) >= 0.5) {
        carried.push({ f: faceId, p: r.person_id });
      }
    }
    if (crops[i]) cropWrites.push(putCrop(c, faceId, crops[i] as Uint8Array));
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO faces (id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, det_score,
           embedding, embedding_model, person_id, assign_status, match_score, created_at, crop_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'unassigned', NULL, ?, ?)`
      ).bind(
        faceId, photo.id, f.bbox.x, f.bbox.y, f.bbox.w, f.bbox.h, f.detScore,
        blobs[i].buffer, model, now, crops[i] ? cropKey(faceId) : null
      )
    );
  });
  if (carried.length > 0) {
    statements.push(
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO face_rejections (face_id, person_id)
         SELECT json_extract(value, '$.f'), json_extract(value, '$.p') FROM json_each(?)`
      ).bind(JSON.stringify(carried))
    );
  }
  statements.push(
    c.env.DB.prepare('UPDATE photos SET faces_scanned_model = ? WHERE id = ?').bind(model, photo.id)
  );
  // Images first: a failed batch then leaves only unreferenced objects behind.
  await Promise.all(cropWrites);
  await c.env.DB.batch(statements);
  if (stale.results.length > 0) await c.env.THUMBNAILS.delete(stale.results.map((r) => r.crop_key));

  const { matched, skipped } = await autoMatchFaces(c.env.DB, newIds);

  return c.json({ stored, kept, matched, skipped });
}
