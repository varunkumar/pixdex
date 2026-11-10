import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      // Fake owner address for tests; the real value is deploy config, not committed.
      miniflare: { bindings: { OWNER_EMAIL: 'owner@example.com' } },
    }),
  ],
  test: {
    setupFiles: ['./test/setup.ts'],
  },
});
