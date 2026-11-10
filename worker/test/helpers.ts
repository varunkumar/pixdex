import { env } from 'cloudflare:test';

export const OWNER_TEST_EMAIL = 'owner@example.com';

/** Read-token auth plus the forwarded viewer identity (defaults to the owner). */
export function readHeaders(email: string = OWNER_TEST_EMAIL): Record<string, string> {
  return { Authorization: `Bearer ${env.READ_TOKEN}`, 'X-Viewer-Email': email };
}
