import type { Context, Next } from 'hono';
import type { Env } from './types';

export interface User {
  email: string;
  isDefaultOwner: boolean;
}

/** Resolves the viewer from the proxy-forwarded X-Viewer-Email (checked by requireReadToken). */
export function userOf(c: Context<{ Bindings: Env }>): User {
  const email = (c.req.header('X-Viewer-Email') ?? '').trim().toLowerCase();
  const owner = (c.env.OWNER_EMAIL ?? '').trim().toLowerCase();
  return { email, isDefaultOwner: owner !== '' && email === owner };
}

export async function requireDefaultOwner(c: Context<{ Bindings: Env }>, next: Next) {
  if (!userOf(c).isDefaultOwner) {
    return c.text('Forbidden', 403);
  }
  await next();
}
