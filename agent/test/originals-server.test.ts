import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

  it('does not crash the server when the file errors while streaming after headers are already committed', async () => {
    // access()/stat() only check existence, not readability, so a file that loses its read
    // permission after being stat-ed (but before the read stream actually opens it) reproduces
    // the same class of failure as a mid-request delete: the stream's 'error' event fires after
    // res.writeHead(200, ...) has already run. This test is skipped when running as root, since
    // root bypasses file permission checks and the read would then unexpectedly succeed.
    if (process.getuid && process.getuid() === 0) {
      return;
    }

    const restrictedPath = path.join(dir, 'restricted.jpg');
    await writeFile(restrictedPath, 'fake jpeg bytes');
    await chmod(restrictedPath, 0o000);

    await start({
      fetchIndexedPhoto: vi
        .fn()
        .mockResolvedValueOnce({ source: 'local', path: restrictedPath })
        .mockResolvedValueOnce({ source: 'local', path: filePath }),
    });

    // The first request's stream errors before any bytes are flushed, so the connection is
    // destroyed and the fetch itself rejects rather than resolving with a body.
    await expect(fetch(`${baseUrl}/originals/photo-1?token=originals-secret`)).rejects.toBeTruthy();

    // Crucially, the server process must still be alive and able to serve further requests.
    const response = await fetch(`${baseUrl}/originals/photo-2?token=originals-secret`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('fake jpeg bytes');

    await chmod(restrictedPath, 0o600);
  });

  it('returns 404 for an unrecognized path shape', async () => {
    await start({ fetchIndexedPhoto: vi.fn() });
    const response = await fetch(`${baseUrl}/not-originals/photo-1`);
    expect(response.status).toBe(404);
  });
});
