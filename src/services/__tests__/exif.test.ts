import { describe, expect, it } from 'vitest';
import { exifSummary, formatPhotoDate, mapsUrl } from '../exif';

describe('exifSummary', () => {
  it('formats camera, lens and exposure settings', () => {
    expect(
      exifSummary({
        cameraModel: 'NIKON Z 8',
        lensModel: 'VR 200-500mm f/5.6E',
        focalLength: 500,
        fNumber: 5.6,
        exposureTime: 0.004,
        iso: 2500,
      })
    ).toEqual(['NIKON Z 8', 'VR 200-500mm f/5.6E', '500mm', 'f/5.6', '1/250s', 'ISO 2500']);
  });

  it('skips missing values and formats long exposures', () => {
    expect(exifSummary({ cameraModel: null, exposureTime: 2, iso: null })).toEqual(['2s']);
    expect(exifSummary({})).toEqual([]);
  });
});

describe('formatPhotoDate / mapsUrl', () => {
  it('returns null for missing or invalid dates', () => {
    expect(formatPhotoDate(null)).toBeNull();
    expect(formatPhotoDate('not a date')).toBeNull();
    expect(formatPhotoDate('2026-09-12T12:29:23.000Z')).toMatch(/2026/);
  });

  it('builds a maps link only when both coordinates exist', () => {
    expect(mapsUrl({ latitude: 11.67, longitude: 76.63 })).toBe('https://www.google.com/maps?q=11.67,76.63');
    expect(mapsUrl({ latitude: 11.67, longitude: null })).toBeNull();
  });
});
