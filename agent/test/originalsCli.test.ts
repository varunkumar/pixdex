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
  OWNER_EMAIL: 'owner@example.com',
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

  it('returns 1 with a clear message, without starting a server, when OWNER_EMAIL is unset', () => {
    const createServer = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = runServeOriginals({ ...baseConfig, OWNER_EMAIL: undefined }, { createServer });

    expect(code).toBe(1);
    expect(createServer).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/OWNER_EMAIL must be set/));
    error.mockRestore();
  });

  it('returns 1 without starting a server when READ_TOKEN is unset', () => {
    const createServer = vi.fn();
    const code = runServeOriginals({ ...baseConfig, READ_TOKEN: undefined }, { createServer });

    expect(code).toBe(1);
    expect(createServer).not.toHaveBeenCalled();
  });
});
