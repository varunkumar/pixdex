import type { Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { exifFieldsSchema } from '../db/photos';

const requestSchema = exifFieldsSchema.extend({ contentHash: z.string().min(1) });

/**
 * Backfills camera/EXIF columns onto an already-indexed photo, keyed by
 * content hash, so existing photos do not need another (slow) vision pass.
 * Camera and lens names are also appended to search_text once.
 */
export async function ingestExifRoute(c: Context<{ Bindings: Env }>) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }
  const p = parsed.data;
  const searchTerms = [p.cameraModel, p.lensModel].filter(Boolean).join(' ');

  const result = await c.env.DB.prepare(
    `UPDATE photos SET
       camera_make = ?, camera_model = ?, lens_model = ?, focal_length = ?,
       f_number = ?, exposure_time = ?, iso = ?, latitude = ?, longitude = ?,
       search_text = CASE
         WHEN ? = '' OR instr(search_text, ?) > 0 THEN search_text
         ELSE search_text || ' ' || ?
       END
     WHERE content_hash = ?`
  )
    .bind(
      p.cameraMake ?? null, p.cameraModel ?? null, p.lensModel ?? null, p.focalLength ?? null,
      p.fNumber ?? null, p.exposureTime ?? null, p.iso ?? null, p.latitude ?? null, p.longitude ?? null,
      searchTerms, searchTerms, searchTerms,
      p.contentHash
    )
    .run();

  if (!result.meta.changes) {
    return c.json({ error: 'Unknown content hash' }, 404);
  }
  return c.json({ updated: 1 });
}
