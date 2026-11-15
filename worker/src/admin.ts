import type { Context, Next } from 'hono';
import { userOf } from './access';
import type { Env } from './types';

/** True when the viewer is the configured admin. One env read, no D1. */
export function isAdmin(c: Context<{ Bindings: Env }>): boolean {
  const email = userOf(c).email;
  const admin = (c.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
  return email !== '' && email === admin;
}

/** Admin-only routes answer 404 to everyone else so their existence is not revealed. */
export async function requireAdmin(c: Context<{ Bindings: Env }>, next: Next) {
  if (!isAdmin(c)) return c.text('Not Found', 404);
  await next();
}
