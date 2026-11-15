import type { Context, Next } from 'hono';
import { userOf } from './access';
import type { Env } from './types';

/** The configured admin email, trimmed and lowercased; '' when ADMIN_EMAIL is unset or blank. No D1. */
export function adminEmail(env: Pick<Env, 'ADMIN_EMAIL'>): string {
  return (env.ADMIN_EMAIL ?? '').trim().toLowerCase();
}

/**
 * True when the viewer is the configured admin. One env read, no D1. An empty viewer or an empty admin
 * value never matches, so a blank or unset ADMIN_EMAIL makes nobody the admin.
 */
export function isAdmin(c: Context<{ Bindings: Env }>): boolean {
  const email = userOf(c).email;
  const admin = adminEmail(c.env);
  return email !== '' && admin !== '' && email === admin;
}

/** Admin-only routes answer 404 to everyone else so their existence is not revealed. */
export async function requireAdmin(c: Context<{ Bindings: Env }>, next: Next) {
  if (!isAdmin(c)) return c.text('Not Found', 404);
  await next();
}
