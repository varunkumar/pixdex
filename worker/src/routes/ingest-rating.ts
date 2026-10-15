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
 * also appended to search_text once (the update trigger keeps FTS in sync).
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

  const result = await c.env.DB.prepare(
    `UPDATE photos SET
       aesthetic_score = COALESCE(?, aesthetic_score),
       short_caption = COALESCE(?, short_caption),
       search_text = CASE
         WHEN ? = '' OR instr(search_text, ?) > 0 THEN search_text
         ELSE search_text || ' ' || ?
       END
     WHERE content_hash = ?`
  )
    .bind(p.score ?? null, p.shortCaption ?? null, caption, caption, caption, p.contentHash)
    .run();

  if (!result.meta.changes) {
    return c.json({ error: 'Unknown content hash' }, 404);
  }
  return c.json({ updated: 1 });
}
