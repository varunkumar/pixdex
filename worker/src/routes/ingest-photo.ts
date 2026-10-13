import type { Context } from 'hono';
import type { Env } from '../types';
import { buildSearchText, ingestPhotoSchema } from '../db/photos';

export async function ingestPhotoRoute(c: Context<{ Bindings: Env }>) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = ingestPhotoSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }
  const p = parsed.data;
  const searchText = buildSearchText(p);
  const now = new Date().toISOString();

  try {
    await c.env.DB.prepare(
      `INSERT INTO photos (
         id, content_hash, source, path, drive_file_id, filename, date_time,
         width, height, format, file_size, subjects, colors, patterns, tags,
         season, environment, album, description, suggested_caption,
         suggested_hashtags, model_provider, model_name, search_text, last_indexed,
         camera_make, camera_model, lens_model, focal_length, f_number,
         exposure_time, iso, latitude, longitude, has_watermark
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         content_hash = excluded.content_hash,
         source = excluded.source,
         path = excluded.path,
         drive_file_id = excluded.drive_file_id,
         filename = excluded.filename,
         date_time = excluded.date_time,
         width = excluded.width,
         height = excluded.height,
         format = excluded.format,
         file_size = excluded.file_size,
         subjects = excluded.subjects,
         colors = excluded.colors,
         patterns = excluded.patterns,
         tags = excluded.tags,
         season = excluded.season,
         environment = excluded.environment,
         album = excluded.album,
         description = excluded.description,
         suggested_caption = excluded.suggested_caption,
         suggested_hashtags = excluded.suggested_hashtags,
         model_provider = excluded.model_provider,
         model_name = excluded.model_name,
         search_text = excluded.search_text,
         last_indexed = excluded.last_indexed,
         camera_make = excluded.camera_make,
         camera_model = excluded.camera_model,
         lens_model = excluded.lens_model,
         focal_length = excluded.focal_length,
         f_number = excluded.f_number,
         exposure_time = excluded.exposure_time,
         iso = excluded.iso,
         latitude = excluded.latitude,
         longitude = excluded.longitude,
         has_watermark = excluded.has_watermark`
    )
      .bind(
        p.id, p.contentHash, p.source, p.path ?? null, p.driveFileId ?? null, p.filename,
        p.dateTime ?? null, p.width ?? null, p.height ?? null, p.format ?? null, p.fileSize ?? null,
        JSON.stringify(p.subjects), JSON.stringify(p.colors), JSON.stringify(p.patterns), JSON.stringify(p.tags),
        p.season ?? null, p.environment ?? null, p.album ?? null, p.description,
        p.suggestedCaption, JSON.stringify(p.suggestedHashtags), p.modelProvider, p.modelName,
        searchText, now,
        p.cameraMake ?? null, p.cameraModel ?? null, p.lensModel ?? null,
        p.focalLength ?? null, p.fNumber ?? null, p.exposureTime ?? null,
        p.iso ?? null, p.latitude ?? null, p.longitude ?? null,
        p.hasWatermark === undefined ? null : p.hasWatermark ? 1 : 0
      )
      .run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE constraint failed') && message.includes('content_hash')) {
      return c.json({ error: 'content_hash already exists for a different id' }, 409);
    }
    throw err;
  }

  return c.json({ id: p.id }, 201);
}
