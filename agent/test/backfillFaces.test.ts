import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backfillFaces } from '../src/backfillFaces';

describe('backfillFaces', () => {
  let dir: string;
  let fileA: string;
  let fileB: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pixdex-bf-faces-'));
    fileA = path.join(dir, 'a.jpg');
    fileB = path.join(dir, 'b.jpg');
    await sharp({ create: { width: 50, height: 50, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toFile(fileA);
    await sharp({ create: { width: 50, height: 50, channels: 3, background: { r: 9, g: 9, b: 9 } } }).jpeg().toFile(fileB);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const sidecarWith = (faces: unknown[]) => ({
    model: vi.fn().mockResolvedValue('buffalo_l'),
    detect: vi.fn().mockResolvedValue({ model: 'buffalo_l', width: 50, height: 50, faces }),
  });

  it('scans only what the index says is unscanned, without walking folders', async () => {
    const sidecar = sidecarWith([{ bbox: [5, 5, 25, 25], detScore: 0.9, embedding: 'e' }]);
    const cloudflareClient = {
      facesUnscanned: vi.fn().mockResolvedValue({ items: [{ contentHash: 'hA', path: fileA }], nextCursor: null }),
      ingestFaces: vi.fn().mockResolvedValue({ faceIds: [] }),
    };

    const result = await backfillFaces({ cloudflareClient: cloudflareClient as any, sidecar: sidecar as any });

    expect(result).toEqual({ total: 1, scanned: 1, faces: 1, missing: 0, notIndexed: 0, failed: 0 });
    expect(sidecar.detect).toHaveBeenCalledTimes(1);
    expect(cloudflareClient.ingestFaces).toHaveBeenCalledWith('hA', 'buffalo_l', expect.any(Array));
    expect(cloudflareClient.facesUnscanned).toHaveBeenCalledWith('buffalo_l', { cursor: undefined, pathPrefix: undefined });
  });

  it('follows the cursor across pages and passes the path prefix', async () => {
    const sidecar = sidecarWith([]);
    const cloudflareClient = {
      facesUnscanned: vi
        .fn()
        .mockResolvedValueOnce({ items: [{ contentHash: 'hA', path: fileA }], nextCursor: 7 })
        .mockResolvedValueOnce({ items: [{ contentHash: 'hB', path: fileB }], nextCursor: null }),
      ingestFaces: vi.fn().mockResolvedValue({ faceIds: [] }),
    };

    const result = await backfillFaces({
      cloudflareClient: cloudflareClient as any,
      sidecar: sidecar as any,
      pathPrefix: '/Volumes/T9/Photos/',
    });

    expect(result.scanned).toBe(2);
    expect(cloudflareClient.facesUnscanned).toHaveBeenNthCalledWith(1, 'buffalo_l', { cursor: undefined, pathPrefix: '/Volumes/T9/Photos/' });
    expect(cloudflareClient.facesUnscanned).toHaveBeenNthCalledWith(2, 'buffalo_l', { cursor: 7, pathPrefix: '/Volumes/T9/Photos/' });
  });

  it('counts a file that is not on disk as missing, not failed, and never calls the sidecar for it', async () => {
    const sidecar = sidecarWith([]);
    const cloudflareClient = {
      facesUnscanned: vi.fn().mockResolvedValue({ items: [{ contentHash: 'hX', path: path.join(dir, 'gone.jpg') }], nextCursor: null }),
      ingestFaces: vi.fn(),
    };

    const result = await backfillFaces({ cloudflareClient: cloudflareClient as any, sidecar: sidecar as any });

    expect(result).toEqual({ total: 1, scanned: 0, faces: 0, missing: 1, notIndexed: 0, failed: 0 });
    expect(sidecar.detect).not.toHaveBeenCalled();
  });

  it('counts not-indexed and failed separately', async () => {
    const sidecar = sidecarWith([]);
    sidecar.detect
      .mockRejectedValueOnce(new Error('sidecar down'))
      .mockResolvedValue({ model: 'buffalo_l', width: 50, height: 50, faces: [] });
    const cloudflareClient = {
      facesUnscanned: vi.fn().mockResolvedValue({
        items: [
          { contentHash: 'hA', path: fileA },
          { contentHash: 'hB', path: fileB },
        ],
        nextCursor: null,
      }),
      ingestFaces: vi.fn().mockResolvedValue(null),
    };

    const result = await backfillFaces({ cloudflareClient: cloudflareClient as any, sidecar: sidecar as any });

    expect(result.total).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.notIndexed).toBe(1);
    expect(result.scanned).toBe(0);
  });
});
