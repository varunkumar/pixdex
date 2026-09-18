import type { Context, Next } from 'hono';
import type { Env } from './types';

export async function requireIngestToken(
  c: Context<{ Bindings: Env }>,
  next: Next
) {
  const header = c.req.header('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';

  if (!token || token !== c.env.INGEST_TOKEN) {
    return c.text('Unauthorized', 401);
  }

  await next();
}
