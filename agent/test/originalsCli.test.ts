import { describe, expect, it, vi } from 'vitest';
import { runServeOriginals } from '../src/originalsCli';
import type { AgentConfig } from '../src/config';

const baseConfig: AgentConfig = {
  CLOUDFLARE_API_BASE_URL: 'https://example.workers.dev',
  INGEST_TOKEN: 'secret-token',
  OLLAMA_BASE_URL: 'http://localhost:11434',
  OLLAMA_MODEL: 'qwen3.5:27b-mlx',
  ORIGINALS_PORT: 8787,
  ORIGINALS_TOKEN: 'originals-secret',
  READ_TOKEN: 'the-read-token',
};

describe('runServeOriginals', () => {
  it('starts the server on ORIGINALS_PORT and returns 0', () => {
    const listen = vi.fn((_port: number, cb: () => void) => cb());
    const createServer = vi.fn().mockReturnValue({ listen });

    const code = runServeOriginals(baseConfig, { createServer });

    expect(code).toBe(0);
    expect(createServer).toHaveBeenCalledWith(baseConfig);
    expect(listen).toHaveBeenCalledWith(8787, expect.any(Function));
  });

  it('returns 1 without starting a server when ORIGINALS_TOKEN is unset', () => {
    const createServer = vi.fn();
    const code = runServeOriginals({ ...baseConfig, ORIGINALS_TOKEN: undefined }, { createServer });

    expect(code).toBe(1);
    expect(createServer).not.toHaveBeenCalled();
  });

  it('returns 1 without starting a server when READ_TOKEN is unset', () => {
    const createServer = vi.fn();
    const code = runServeOriginals({ ...baseConfig, READ_TOKEN: undefined }, { createServer });

    expect(code).toBe(1);
    expect(createServer).not.toHaveBeenCalled();
  });
});
