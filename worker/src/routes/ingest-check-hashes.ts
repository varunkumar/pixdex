import { z } from 'zod';
import type { Context } from 'hono';
import type { Env } from '../types';

const requestSchema = z.object({
  hashes: z.array(z.string()).max(500),
});

export async function checkHashesRoute(c: Context<{ Bindings: Env }>) {
  const body = requestSchema.safeParse(await c.req.json());
  if (!body.success) {
    return c.json({ error: body.error.flatten() }, 400);
  }

  const { hashes } = body.data;
  if (hashes.length === 0) {
    return c.json({ known: [] });
  }

  const placeholders = hashes.map(() => '?').join(',');
  const result = await c.env.DB.prepare(
    `SELECT content_hash FROM photos WHERE content_hash IN (${placeholders})`
  )
    .bind(...hashes)
    .all<{ content_hash: string }>();

  return c.json({ known: result.results.map((r) => r.content_hash) });
}
