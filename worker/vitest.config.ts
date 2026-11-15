import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      // Test-only dummy values (never real secrets); .dev.vars is git-ignored.
      miniflare: {
        bindings: {
          ADMIN_EMAIL: 'owner@example.com',
          CF_API_TOKEN: 'test-cf-api-token',
          CF_ACCOUNT_ID: 'test-account-id',
          CF_ACCESS_GROUP_ID: 'test-access-group-id',
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/setup.ts'],
  },
});
