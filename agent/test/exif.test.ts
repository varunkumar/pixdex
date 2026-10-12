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

  it('reads camera make, model and lens from EXIF', async () => {
    const withExif = path.join(dir, 'camera.jpg');
    await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .withExif({ IFD0: { Make: 'NIKON CORPORATION', Model: 'NIKON Z 8' } })
      .jpeg()
      .toFile(withExif);

    const result = await extractExifData(withExif);
    expect(result.camera.cameraMake).toBe('NIKON CORPORATION');
    expect(result.camera.cameraModel).toBe('NIKON Z 8');
  });

  it('leaves camera fields undefined when the file has none', async () => {
    const result = await extractExifData(filePath);
    expect(result.camera).toEqual({
      cameraMake: undefined,
      cameraModel: undefined,
      lensModel: undefined,
      focalLength: undefined,
      fNumber: undefined,
      exposureTime: undefined,
      iso: undefined,
      latitude: undefined,
      longitude: undefined,
    });
  });
});
