import type { Context } from 'hono';
import type { Env } from '../types';
import { buildSearchText, ingestPhotoSchema } from '../db/photos';

export async function ingestPhotoRoute(c: Context<{ Bindings: Env }>) {
  const parsed = ingestPhotoSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }
  const p = parsed.data;
  const searchText = buildSearchText(p);
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    `INSERT INTO photos (
       id, content_hash, source, path, drive_file_id, filename, date_time,
       width, height, format, file_size, subjects, colors, patterns, tags,
       season, environment, album, description, suggested_caption,
       suggested_hashtags, model_provider, model_name, search_text, last_indexed
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       content_hash = excluded.content_hash,
       subjects = excluded.subjects,
       colors = excluded.colors,
       patterns = excluded.patterns,
       tags = excluded.tags,
       season = excluded.season,
       environment = excluded.environment,
       description = excluded.description,
       suggested_caption = excluded.suggested_caption,
       suggested_hashtags = excluded.suggested_hashtags,
       model_provider = excluded.model_provider,
       model_name = excluded.model_name,
       search_text = excluded.search_text,
       last_indexed = excluded.last_indexed`
  )
    .bind(
      p.id, p.contentHash, p.source, p.path ?? null, p.driveFileId ?? null, p.filename,
      p.dateTime ?? null, p.width ?? null, p.height ?? null, p.format ?? null, p.fileSize ?? null,
      JSON.stringify(p.subjects), JSON.stringify(p.colors), JSON.stringify(p.patterns), JSON.stringify(p.tags),
      p.season ?? null, p.environment ?? null, p.album ?? null, p.description,
      p.suggestedCaption, JSON.stringify(p.suggestedHashtags), p.modelProvider, p.modelName,
      searchText, now
    )
    .run();

  return c.json({ id: p.id }, 201);
}
