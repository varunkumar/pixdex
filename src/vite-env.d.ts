/// <reference types="vite/client" />
/// <reference types="@testing-library/jest-dom/vitest" />

interface ImportMetaEnv {
  readonly VITE_WORKER_API_BASE_URL: string;
  readonly VITE_WORKER_READ_TOKEN: string;
  readonly VITE_ORIGINALS_BASE_URL?: string;
  readonly VITE_ORIGINALS_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
