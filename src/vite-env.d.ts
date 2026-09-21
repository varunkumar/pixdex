/// <reference types="vite/client" />
/// <reference types="@testing-library/jest-dom/vitest" />

interface ImportMetaEnv {
  readonly VITE_WORKER_API_BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
