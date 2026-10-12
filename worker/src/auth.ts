import type { Context, Next } from 'hono';
import type { Env } from './types';

function bearerToken(c: Context<{ Bindings: Env }>): string {
  const header = c.req.header('Authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
}

export async function requireIngestToken(
  c: Context<{ Bindings: Env }>,
  next: Next
) {
  const token = bearerToken(c);

  if (!token || token !== c.env.INGEST_TOKEN) {
    return c.text('Unauthorized', 401);
  }

  await next();
}

/** Bearer header only: tokens in URLs end up in logs and browser history. */
export async function requireReadToken(
  c: Context<{ Bindings: Env }>,
  next: Next
) {
  const token = bearerToken(c);

  if (!token || token !== c.env.READ_TOKEN) {
    return c.text('Unauthorized', 401);
  }

  await next();
}
