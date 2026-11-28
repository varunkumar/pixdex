import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadGazetteer, nearestTown, parseGazetteer } from '../src/places/gazetteer';

/** One GeoNames line: only the name, position and country columns matter. */
const line = (name: string, lat: number, lon: number, country: string) =>
  ['1', name, name, '', String(lat), String(lon), 'P', 'PPL', country, '', '', '', '', '', '1000', '', '', 'Asia/Kolkata', '2026-01-01'].join('\t');

const TEXT = [
  line('Gundlupet', 11.81, 76.69, 'IN'),
  line('Mysuru', 12.3, 76.64, 'IN'),
  line('Edgeton', 11.0, 77.001, 'IN'),
  line('Dateline', -16.5, -179.9, 'FJ'),
  'broken line',
  '',
].join('\n');

describe('gazetteer', () => {
  const g = parseGazetteer(TEXT);

  it('gives the nearest town with its country', () => {
    expect(nearestTown(g, 11.67, 76.63)).toBe('Gundlupet, IN');
    expect(nearestTown(g, 12.25, 76.6)).toBe('Mysuru, IN');
  });

  it('gives an empty name when no town is within 50 km', () => {
    expect(nearestTown(g, 0, 0)).toBe('');
    expect(nearestTown(g, 13.0, 76.64)).toBe('');
    expect(nearestTown(g, 13.0, 76.64, 100)).toBe('Mysuru, IN');
  });

  it('looks across a degree cell edge and across the 180 degree line', () => {
    expect(nearestTown(g, 10.99, 76.999)).toBe('Edgeton, IN');
    expect(nearestTown(g, -16.5, 179.9)).toBe('Dateline, FJ');
  });

  describe('loadGazetteer', () => {
    let dir: string | undefined;
    afterEach(async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    it('reads a file, and gives undefined when there is none', async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'pixdex-geo-'));
      const file = path.join(dir, 'cities500.txt');
      expect(await loadGazetteer(file)).toBeUndefined();
      await writeFile(file, TEXT);
      expect(nearestTown((await loadGazetteer(file))!, 11.81, 76.69)).toBe('Gundlupet, IN');
    });
  });
});
