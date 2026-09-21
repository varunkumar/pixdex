import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('parses a valid environment', () => {
    const config = loadConfig({
      CLOUDFLARE_API_BASE_URL: 'https://example.workers.dev',
      INGEST_TOKEN: 'secret-token',
    });
    expect(config.CLOUDFLARE_API_BASE_URL).toBe('https://example.workers.dev');
    expect(config.INGEST_TOKEN).toBe('secret-token');
    expect(config.OLLAMA_BASE_URL).toBe('http://localhost:11434');
    expect(config.OLLAMA_MODEL).toBe('qwen3.5:27b-mlx');
  });

  it('throws when a required variable is missing', () => {
    expect(() => loadConfig({})).toThrow(/Invalid agent configuration/);
  });

  it('respects an explicit OLLAMA_MODEL override', () => {
    const config = loadConfig({
      CLOUDFLARE_API_BASE_URL: 'https://example.workers.dev',
      INGEST_TOKEN: 'secret-token',
      OLLAMA_MODEL: 'some-other-model',
    });
    expect(config.OLLAMA_MODEL).toBe('some-other-model');
  });

  it('defaults ORIGINALS_PORT to 8787 and leaves ORIGINALS_TOKEN unset', () => {
    const config = loadConfig({
      CLOUDFLARE_API_BASE_URL: 'https://example.workers.dev',
      INGEST_TOKEN: 'secret-token',
    });
    expect(config.ORIGINALS_PORT).toBe(8787);
    expect(config.ORIGINALS_TOKEN).toBeUndefined();
  });

  it('respects explicit ORIGINALS_PORT and ORIGINALS_TOKEN overrides', () => {
    const config = loadConfig({
      CLOUDFLARE_API_BASE_URL: 'https://example.workers.dev',
      INGEST_TOKEN: 'secret-token',
      ORIGINALS_PORT: '9000',
      ORIGINALS_TOKEN: 'originals-secret',
    });
    expect(config.ORIGINALS_PORT).toBe(9000);
    expect(config.ORIGINALS_TOKEN).toBe('originals-secret');
  });
});
