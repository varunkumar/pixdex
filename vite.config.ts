/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { mockApiPlugin } from './dev/mockApi.ts'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Non-VITE_ vars: read here in Node only, never exposed to the client bundle.
  const env = loadEnv(mode, process.cwd(), '');
  // The Worker requires a viewer identity on every read. In dev there is no
  // Access JWT, so the proxy asserts one: DEV_VIEWER_EMAIL (to try another
  // user's view) or else OWNER_EMAIL (the album owner, dev only).
  const viewerEmail = env.DEV_VIEWER_EMAIL || env.OWNER_EMAIL;
  // PIXDEX_MOCK=1 npm run dev: dummy /api data from dev/mockApi.ts (serve only, no .env or secrets needed, the
  // proxy is left out). Read in Node only; the plugin has apply: 'serve', so a build never contains it.
  const mock = (env.PIXDEX_MOCK ?? process.env.PIXDEX_MOCK) === '1';
  return {
    plugins: [react(), ...(mock ? [mockApiPlugin()] : [])],
    // Dev-time stand-in for the Pages Function in functions/api: adds the read token
    // and the viewer identity (no Access JWT check, and no per-user originals check).
    server: {
      proxy: mock ? undefined : {
        // Must come before '/api' so originals go to the tunnel, not the Worker.
        '/api/originals': {
          target: env.ORIGINALS_BASE_URL,
          changeOrigin: true,
          rewrite: (path: string) => path.replace(/^\/api/, ''),
          headers: {
            Authorization: `Bearer ${env.ORIGINALS_TOKEN}`,
            ...(env.ACCESS_CLIENT_ID && env.ACCESS_CLIENT_SECRET
              ? {
                  'CF-Access-Client-Id': env.ACCESS_CLIENT_ID,
                  'CF-Access-Client-Secret': env.ACCESS_CLIENT_SECRET,
                }
              : {}),
          },
        },
        '/api': {
          target: env.WORKER_URL,
          changeOrigin: true,
          rewrite: (path: string) => path.replace(/^\/api/, ''),
          headers: {
            Authorization: `Bearer ${env.READ_TOKEN}`,
            ...(viewerEmail ? { 'X-Viewer-Email': viewerEmail } : {}),
          },
        },
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./test/setup.ts'],
      globals: true,
      include: ['src/**/*.{test,spec}.{ts,tsx}', 'test/**/*.test.ts', 'functions/**/*.test.ts'],
    },
  };
})
