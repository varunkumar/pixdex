import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOriginalsServer } from '../src/originals/server';
import type { AgentConfig } from '../src/config';

const config: AgentConfig = {
  CLOUDFLARE_API_BASE_URL: 'https://example.workers.dev',
  INGEST_TOKEN: 'secret-token',
  OLLAMA_BASE_URL: 'http://localhost:11434',
  OLLAMA_MODEL: 'qwen3.5:27b-mlx',
  ORIGINALS_PORT: 8787,
  ORIGINALS_TOKEN: 'originals-secret',
};

describe('originals server', () => {
  let dir: string;
  let filePath: string;
  let baseUrl: string;
  let server: ReturnType<typeof createOriginalsServer>;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pixdex-originals-'));
    filePath = path.join(dir, 'photo.jpg');
    await writeFile(filePath, 'fake jpeg bytes');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  });

  async function start(deps: Parameters<typeof createOriginalsServer>[1] = {}) {
    server = createOriginalsServer(config, deps);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  }

  it('streams the file for a known local photo with a valid token', async () => {
    await start({ fetchIndexedPhoto: vi.fn().mockResolvedValue({ source: 'local', path: filePath }) });

    const response = await fetch(`${baseUrl}/originals/photo-1?token=originals-secret`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('fake jpeg bytes');
  });

  it('rejects a missing or wrong token', async () => {
    await start({ fetchIndexedPhoto: vi.fn() });
    const response = await fetch(`${baseUrl}/originals/photo-1?token=wrong`);
    expect(response.status).toBe(401);
  });

  it('returns 404 for a Drive-sourced photo, since there is no local path to serve', async () => {
    await start({ fetchIndexedPhoto: vi.fn().mockResolvedValue({ source: 'google_drive', path: null }) });
    const response = await fetch(`${baseUrl}/originals/photo-1?token=originals-secret`);
    expect(response.status).toBe(404);
  });

  it('returns 404 when the file no longer exists on disk', async () => {
    await start({
      fetchIndexedPhoto: vi.fn().mockResolvedValue({ source: 'local', path: path.join(dir, 'missing.jpg') }),
    });
    const response = await fetch(`${baseUrl}/originals/photo-1?token=originals-secret`);
    expect(response.status).toBe(404);
  });

  it('returns 404 for an unrecognized path shape', async () => {
    await start({ fetchIndexedPhoto: vi.fn() });
    const response = await fetch(`${baseUrl}/not-originals/photo-1`);
    expect(response.status).toBe(404);
  });
});
