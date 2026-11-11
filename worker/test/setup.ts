import { env } from 'cloudflare:test';
import { beforeAll, beforeEach } from 'vitest';
import { clearReferencesCache } from '../src/people/references';
import { PHOTOS_MIGRATION_STATEMENTS } from '../migrations/index';
import { ALBUM_OWNER_FIXTURE_SQL } from './helpers';

beforeAll(async () => {
  // Execute migrations before tests run
  // Workaround: vitest-pool-workers doesn't auto-apply migrations from migrations_dir during testing
  // Migration statements are defined once in migrations/index.ts to avoid duplication

  for (const statement of PHOTOS_MIGRATION_STATEMENTS) {
    try {
      await env.DB.prepare(statement).run();
    } catch (error) {
      throw new Error(
        `Failed to execute migration statement: ${error instanceof Error ? error.message : String(error)}\n\nStatement: ${statement}`
      );
    }
  }
});

/**
 * Test convenience: an album created while this trigger exists is owned by OWNER_TEST_EMAIL, so a test
 * that only inserts photos has an album owner without stamping it. There is no default owner in the
 * Worker; this is just a fixture. Tests of ownerless albums or of the ingest stamping call
 * withoutAlbumOwnerFixture() (helpers.ts).
 */
beforeAll(async () => {
  await env.DB.prepare(ALBUM_OWNER_FIXTURE_SQL).run();
});

beforeEach(() => clearReferencesCache());
