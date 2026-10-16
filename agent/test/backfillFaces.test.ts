import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backfillFaces } from '../src/backfillFaces';
import { sha256ContentHash } from '../src/hashing';

describe('backfillFaces', () => {
  let dir: string;
  let hashA: string;
  let hashB: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pixdex-bf-faces-'));
    await sharp({ create: { width: 50, height: 50, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toFile(path.join(dir, 'a.jpg'));
    await sharp({ create: { width: 50, height: 50, channels: 3, background: { r: 9, g: 9, b: 9 } } }).jpeg().toFile(path.join(dir, 'b.jpg'));
    hashA = await sha256ContentHash(path.join(dir, 'a.jpg'));
    hashB = await sha256ContentHash(path.join(dir, 'b.jpg'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const sidecarWith = (faces: unknown[]) => ({
    model: vi.fn().mockResolvedValue('buffalo_l'),
    detect: vi.fn().mockResolvedValue({ model: 'buffalo_l', width: 50, height: 50, faces }),
  });

  it('skips already scanned hashes', async () => {
    const sidecar = sidecarWith([{ bbox: [5, 5, 25, 25], detScore: 0.9, embedding: 'e' }]);
    const cloudflareClient = {
      facesPending: vi.fn().mockResolvedValue(new Set([hashA])),
      ingestFaces: vi.fn().mockResolvedValue(true),
    };

    const result = await backfillFaces(dir, { cloudflareClient: cloudflareClient as any, sidecar: sidecar as any });

    expect(result).toEqual({ total: 2, scanned: 1, faces: 1, skipped: 1, notIndexed: 0, failed: 0 });
    expect(sidecar.detect).toHaveBeenCalledTimes(1);
    expect(cloudflareClient.facesPending).toHaveBeenCalledWith(expect.arrayContaining([hashA, hashB]), 'buffalo_l');
  });

  it('counts not-indexed and failed separately', async () => {
    const sidecar = sidecarWith([]);
    sidecar.detect.mockRejectedValueOnce(new Error('sidecar down')).mockResolvedValue({ model: 'buffalo_l', width: 50, height: 50, faces: [] });
    const cloudflareClient = {
      facesPending: vi.fn().mockResolvedValue(new Set([hashA, hashB])),
      ingestFaces: vi.fn().mockResolvedValue(false),
    };

    const result = await backfillFaces(dir, { cloudflareClient: cloudflareClient as any, sidecar: sidecar as any });

    expect(result.total).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.notIndexed).toBe(1);
    expect(result.scanned).toBe(0);
  });
});
