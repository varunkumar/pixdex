import { env } from 'cloudflare:test';
import { beforeAll } from 'vitest';
import { PHOTOS_MIGRATION_STATEMENTS } from '../migrations/index';

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
