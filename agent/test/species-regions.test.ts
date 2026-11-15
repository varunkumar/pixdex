import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRegionFile, normalizeBinomial, resolveRegion, type RegionsConfig } from '../src/species/regions';

const config: RegionsConfig = {
  default: 'IN',
  regions: { IN: { country: 'IN' }, 'IN-KA': { country: 'IN', stateProvince: 'Karnataka' } },
  rules: [
    { region: 'IN-KA', bbox: [11.5, 74, 18.5, 78.6] },
    { region: 'IN-KA', albumPattern: 'bandipur|nagarhole' },
  ],
};
const photo = (over: Partial<{ album: string | null; latitude: number | null; longitude: number | null }> = {}) => ({ album: null, latitude: null, longitude: null, ...over });

describe('resolveRegion', () => {
  it('uses the GPS position when it falls in a rule box', () => {
    expect(resolveRegion(photo({ latitude: 11.7, longitude: 76.6 }), config)).toBe('IN-KA');
  });

  it('uses the album name when there is no position, ignoring case', () => {
    expect(resolveRegion(photo({ album: 'Bandipur (29,31-Mar-2025)' }), config)).toBe('IN-KA');
    expect(resolveRegion(photo({ album: 'NAGARHOLE trip' }), config)).toBe('IN-KA');
  });

  it('falls back to the default region', () => {
    expect(resolveRegion(photo({ album: 'Bird Watching (Jan 2025)' }), config)).toBe('IN');
    expect(resolveRegion(photo({ latitude: 28.6, longitude: 77.2 }), config)).toBe('IN');
  });

  it('GPS wins over the album name (first matching rule, boxes listed first)', () => {
    const c: RegionsConfig = { ...config, rules: [{ region: 'IN-RJ', bbox: [24, 70, 30, 78] }, ...config.rules!] , regions: { ...config.regions, 'IN-RJ': { country: 'IN', stateProvince: 'Rajasthan' } } };
    expect(resolveRegion(photo({ album: 'Bandipur', latitude: 26, longitude: 75 }), c)).toBe('IN-RJ');
  });

  it('rejects a rule or default that names an unknown region', () => {
    expect(() => resolveRegion(photo(), { ...config, default: 'XX' })).toThrow(/XX/);
    expect(() => resolveRegion(photo({ album: 'bandipur' }), { ...config, rules: [{ region: 'ZZ', albumPattern: 'bandipur' }] })).toThrow(/ZZ/);
  });
});

describe('normalizeBinomial', () => {
  it('keeps genus and species, dropping authors and subspecies', () => {
    expect(normalizeBinomial('Panthera tigris tigris (Linnaeus, 1758)')).toBe('Panthera tigris');
    expect(normalizeBinomial('Corvus splendens Vieillot, 1817')).toBe('Corvus splendens');
  });
  it('rejects names that are not a species', () => {
    expect(normalizeBinomial('Aves')).toBeNull();
    expect(normalizeBinomial('Genus sp. 1')).toBeNull();
    expect(normalizeBinomial('Pavo x cristatus')).toBeNull();
  });
});

describe('buildRegionFile', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pixdex-regions-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const facets = (names: string[]) => new Response(JSON.stringify({ facets: [{ field: 'SCIENTIFIC_NAME', counts: names.map((name) => ({ name, count: 1 })) }] }), { status: 200 });

  it('asks GBIF per class for the region and writes a sorted, de-duplicated binomial list', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(facets(['Pavo cristatus Linnaeus, 1758', 'Acridotheres tristis (Linnaeus, 1766)']))
      .mockResolvedValueOnce(facets(['Panthera tigris tigris (Linnaeus, 1758)', 'Panthera tigris']))
      .mockResolvedValueOnce(facets(['Duttaphrynus melanostictus (Schneider, 1799)']));

    const file = await buildRegionFile('IN-KA', { country: 'IN', stateProvince: 'Karnataka' }, dir, fetchFn as unknown as typeof fetch);

    const urls = fetchFn.mock.calls.map((c) => new URL(c[0] as string));
    expect(urls.map((u) => u.searchParams.get('taxonKey'))).toEqual(['212', '359', '131']);
    expect(urls[0].searchParams.get('country')).toBe('IN');
    expect(urls[0].searchParams.get('stateProvince')).toBe('Karnataka');
    expect(urls[0].searchParams.get('facet')).toBe('scientificName');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved.region).toBe('IN-KA');
    expect(saved.species).toEqual(['Acridotheres tristis', 'Duttaphrynus melanostictus', 'Panthera tigris', 'Pavo cristatus']);
  });

  it('omits the state filter for a country-wide region', async () => {
    const fetchFn = vi.fn().mockImplementation(async () => facets(['Pavo cristatus']));
    await buildRegionFile('IN', { country: 'IN' }, dir, fetchFn as unknown as typeof fetch);
    expect(new URL(fetchFn.mock.calls[0][0] as string).searchParams.has('stateProvince')).toBe(false);
  });

  it('throws on a GBIF error and writes nothing', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    await expect(buildRegionFile('IN', { country: 'IN' }, dir, fetchFn as unknown as typeof fetch)).rejects.toThrow('503');
    await expect(readFile(path.join(dir, 'IN.json'), 'utf8')).rejects.toThrow();
  });

  it('refuses a region that comes back empty', async () => {
    const fetchFn = vi.fn().mockImplementation(async () => facets([]));
    await expect(buildRegionFile('IN', { country: 'IN' }, dir, fetchFn as unknown as typeof fetch)).rejects.toThrow(/no species/i);
  });
});
