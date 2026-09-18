import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractExifData } from '../src/exif';

describe('extractExifData', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pixdex-exif-'));
    filePath = path.join(dir, 'fixture.jpg');
    await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 100, g: 150, b: 80 } },
    })
      .jpeg()
      .toFile(filePath);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads dimensions and format from an image with no EXIF data', async () => {
    const result = await extractExifData(filePath);
    expect(result.dimensions).toEqual({ width: 800, height: 600 });
    expect(result.format).toBe('jpeg');
    expect(result.dateTime).toBeUndefined();
  });
});
