import type { Context } from 'hono';
import { userOf } from '../access';
import type { Env } from '../types';

/** GET /me: the resolved viewer. No D1 access, constant CPU. */
export function meRoute(c: Context<{ Bindings: Env }>) {
  const { email, isDefaultOwner } = userOf(c);
  return c.json({ email, isDefaultOwner });
}
