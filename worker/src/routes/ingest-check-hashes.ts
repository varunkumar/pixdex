import { z } from 'zod';
import type { Context } from 'hono';
import type { Env } from '../types';

const requestSchema = z.object({
  hashes: z.array(z.string()).max(500),
});

// D1's documented limit is 100 bound parameters per query, so the (up to
// 500) hashes accepted at the API level are checked in chunks of 100.
const D1_MAX_BINDINGS = 100;

export async function checkHashesRoute(c: Context<{ Bindings: Env }>) {
  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const body = requestSchema.safeParse(payload);
  if (!body.success) {
    return c.json({ error: body.error.flatten() }, 400);
  }

  const { hashes } = body.data;
  if (hashes.length === 0) {
    return c.json({ known: [] });
  }

  const known = new Set<string>();
  for (let i = 0; i < hashes.length; i += D1_MAX_BINDINGS) {
    const chunk = hashes.slice(i, i + D1_MAX_BINDINGS);
    const placeholders = chunk.map(() => '?').join(',');
    const result = await c.env.DB.prepare(
      `SELECT content_hash FROM photos WHERE content_hash IN (${placeholders})`
    )
      .bind(...chunk)
      .all<{ content_hash: string }>();
    for (const r of result.results) {
      known.add(r.content_hash);
    }
  }

  return c.json({ known: Array.from(known) });
}
