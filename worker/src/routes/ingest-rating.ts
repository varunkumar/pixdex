import type { Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';

const requestSchema = z
  .object({
    contentHash: z.string().min(1),
    score: z.number().min(1).max(10).optional(),
    shortCaption: z.string().min(1).max(80).optional(),
  })
  .refine((v) => v.score !== undefined || v.shortCaption !== undefined, {
    message: 'score or shortCaption is required',
  });

/**
 * Sets the aesthetic rating and/or short caption on an already-indexed photo,
 * keyed by content hash, so existing photos can be updated without a full
 * re-index. A field that is omitted keeps its current value. The caption is
 * also kept in search_text (the update trigger keeps FTS in sync).
 */
export async function ingestRatingRoute(c: Context<{ Bindings: Env }>) {
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
  const caption = p.shortCaption ?? '';

  // Re-rating replaces the caption: drop the previous one from search_text when
  // it was appended at the end (as this route does) so stale words do not pile up.
  let searchText: string | null = null;
  if (caption) {
    const current = await c.env.DB.prepare(
      'SELECT search_text, short_caption, user_caption FROM photos WHERE content_hash = ?'
    )
      .bind(p.contentHash)
      .first<{ search_text: string; short_caption: string | null; user_caption: string | null }>();
    if (!current) return c.json({ error: 'Unknown content hash' }, 404);
    // The owner's title is what is indexed; the model's new one is stored but not searchable.
    if (current.user_caption) return finish(c, p, null);
    let text = current.search_text;
    const old = current.short_caption;
    if (old && old !== caption && text.endsWith(` ${old}`)) text = text.slice(0, -(old.length + 1));
    searchText = text.includes(caption) ? text : `${text} ${caption}`;
  }

  return finish(c, p, searchText);
}

async function finish(
  c: Context<{ Bindings: Env }>,
  p: z.infer<typeof requestSchema>,
  searchText: string | null
) {
  const result = await c.env.DB.prepare(
    `UPDATE photos SET
       aesthetic_score = COALESCE(?, aesthetic_score),
       short_caption = COALESCE(?, short_caption),
       search_text = COALESCE(?, search_text)
     WHERE content_hash = ?`
  )
    .bind(p.score ?? null, p.shortCaption ?? null, searchText, p.contentHash)
    .run();

  if (!result.meta.changes) {
    return c.json({ error: 'Unknown content hash' }, 404);
  }
  return c.json({ updated: 1 });
}
