import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { identifySpecies } from '../src/species/identify';
import type { RegionsConfig } from '../src/species/regions';

const regions: RegionsConfig = {
  default: 'IN',
  regions: { IN: { country: 'IN' }, 'IN-KA': { country: 'IN', stateProvince: 'Karnataka' } },
  rules: [{ region: 'IN-KA', albumPattern: 'bandipur' }],
};
const tiger = { model: 'bioclip-2', whole: [['Tiger', 'Panthera tigris', 'Mammalia', 0.97]], boxes: [] };

describe('identifySpecies', () => {
  it('sends a 1600 px upright jpeg and the region, and returns the decided species with the model', async () => {
    const original = await sharp({ create: { width: 3200, height: 1600, channels: 3, background: '#333' } }).jpeg().toBuffer();
    const identify = vi.fn().mockResolvedValue(tiger);

    const result = await identifySpecies(original, { album: 'Bandipur 2025', latitude: null, longitude: null }, { sidecar: { identify } as any, regions });

    const [jpeg, region] = identify.mock.calls[0];
    const meta = await sharp(jpeg).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width!, meta.height!)).toBe(1600);
    expect(region).toBe('IN-KA');
    expect(result).toEqual({ model: 'bioclip-2', region: 'IN-KA', species: [{ common: 'Tiger', scientific: 'Panthera tigris', score: 0.97 }] });
  });

  it('does not enlarge a small photo', async () => {
    const original = await sharp({ create: { width: 50, height: 40, channels: 3, background: '#333' } }).jpeg().toBuffer();
    const identify = vi.fn().mockResolvedValue(tiger);
    await identifySpecies(original, { album: null, latitude: null, longitude: null }, { sidecar: { identify } as any, regions });
    expect((await sharp(identify.mock.calls[0][0]).metadata()).width).toBe(50);
  });

  it('applies the EXIF orientation before sending', async () => {
    const original = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#333' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const identify = vi.fn().mockResolvedValue(tiger);
    await identifySpecies(original, { album: null, latitude: null, longitude: null }, { sidecar: { identify } as any, regions });
    const meta = await sharp(identify.mock.calls[0][0]).metadata();
    expect([meta.width, meta.height]).toEqual([100, 200]);
  });
});
