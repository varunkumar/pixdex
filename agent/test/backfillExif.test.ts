import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backfillExif } from '../src/backfillExif';
import { sha256ContentHash } from '../src/hashing';
import type { CloudflareClient } from '../src/cloudflareClient';

describe('backfillExif', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pixdex-backfill-'));
    await sharp({ create: { width: 50, height: 50, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .withExif({ IFD0: { Make: 'NIKON CORPORATION', Model: 'NIKON Z 8' } })
      .jpeg()
      .toFile(path.join(dir, 'a.jpg'));
    await sharp({ create: { width: 50, height: 50, channels: 3, background: { r: 9, g: 9, b: 9 } } })
      .jpeg()
      .toFile(path.join(dir, 'b.jpg'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('sends EXIF per file by content hash and counts unindexed files', async () => {
    const hashA = await sha256ContentHash(path.join(dir, 'a.jpg'));
    const updateExif = vi.fn(async (hash: string) => hash === hashA);
    const client = { updateExif } as unknown as CloudflareClient;

    const result = await backfillExif(dir, { cloudflareClient: client });

    expect(result).toEqual({ total: 2, updated: 1, notIndexed: 1, failed: 0 });
    expect(updateExif).toHaveBeenCalledWith(hashA, expect.objectContaining({ cameraModel: 'NIKON Z 8' }));
  });

  it('counts a failing request as failed and keeps going', async () => {
    const client = { updateExif: vi.fn().mockRejectedValue(new Error('boom')) } as unknown as CloudflareClient;
    const result = await backfillExif(dir, { cloudflareClient: client });
    expect(result).toEqual({ total: 2, updated: 0, notIndexed: 0, failed: 2 });
  });
});
