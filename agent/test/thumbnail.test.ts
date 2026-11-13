import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateThumbnail } from '../src/thumbnail';

const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024; // matches worker/src/routes/ingest-thumbnail.ts

describe('generateThumbnail', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pixdex-thumb-'));
    filePath = path.join(dir, 'fixture.jpg');
    await sharp({
      create: { width: 2000, height: 1500, channels: 3, background: { r: 20, g: 120, b: 60 } },
    })
      .jpeg()
      .toFile(filePath);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('produces a JPEG no larger than 400px on the long edge', async () => {
    const buffer = await generateThumbnail(filePath);
    const metadata = await sharp(buffer).metadata();
    expect(metadata.format).toBe('jpeg');
    expect(metadata.width).toBeLessThanOrEqual(400);
    expect(metadata.height).toBeLessThanOrEqual(400);
  });

  it('stays under the Worker thumbnail size limit', async () => {
    const buffer = await generateThumbnail(filePath);
    expect(buffer.byteLength).toBeLessThan(MAX_THUMBNAIL_BYTES);
  });

  it('applies the EXIF orientation: a landscape file tagged 6 gives a portrait thumbnail', async () => {
    const rotated = path.join(dir, 'rot.jpg');
    await sharp({ create: { width: 2000, height: 1000, channels: 3, background: { r: 9, g: 9, b: 9 } } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toFile(rotated);
    const metadata = await sharp(await generateThumbnail(rotated)).metadata();
    expect(metadata.height).toBeGreaterThan(metadata.width ?? 0);
    expect(metadata.orientation).toBeUndefined();
  });
});
