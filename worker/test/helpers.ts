import { env } from 'cloudflare:test';

export const OWNER_TEST_EMAIL = 'owner@example.com';

/** Read-token auth plus the forwarded viewer identity (defaults to the owner). */
export function readHeaders(email: string = OWNER_TEST_EMAIL): Record<string, string> {
  return { Authorization: `Bearer ${env.READ_TOKEN}`, 'X-Viewer-Email': email };
}

export const ALBUM_OWNER_FIXTURE_SQL = `CREATE TRIGGER IF NOT EXISTS test_album_owner_fixture AFTER INSERT ON albums
WHEN new.owner_email IS NULL
BEGIN UPDATE albums SET owner_email = '${OWNER_TEST_EMAIL}' WHERE name = new.name; END`;

/** Drops the fixture trigger for the current test, so new albums start with no owner. Call restoreAlbumOwnerFixture() after. */
export async function withoutAlbumOwnerFixture(): Promise<void> {
  await env.DB.prepare('DROP TRIGGER IF EXISTS test_album_owner_fixture').run();
}

export async function restoreAlbumOwnerFixture(): Promise<void> {
  await env.DB.prepare(ALBUM_OWNER_FIXTURE_SQL).run();
}
