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

/**
 * Bearer header only: tokens in URLs end up in logs and browser history.
 * Also requires the proxy-forwarded X-Viewer-Email identity.
 */
export async function requireReadToken(
  c: Context<{ Bindings: Env }>,
  next: Next
) {
  const token = bearerToken(c);

  if (!token || token !== c.env.READ_TOKEN) {
    return c.text('Unauthorized', 401);
  }

  // Fail closed: without an owner address or a forwarded identity nobody is resolvable.
  if (!c.env.OWNER_EMAIL || !(c.req.header('X-Viewer-Email') ?? '').trim()) {
    return c.text('Unauthorized', 401);
  }

  await next();
}
