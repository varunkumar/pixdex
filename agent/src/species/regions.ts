import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface RegionDef {
  /** ISO 3166-1 alpha-2 country code, as GBIF uses it. */
  country: string;
  stateProvince?: string;
}

export interface RegionRule {
  region: string;
  /** Case-insensitive regular expression tested against the album name. */
  albumPattern?: string;
  /** [minLat, minLon, maxLat, maxLon]; matches photos whose EXIF position is inside. */
  bbox?: [number, number, number, number];
}

export interface RegionsConfig {
  default: string;
  regions: Record<string, RegionDef>;
  /** First matching rule wins, so list the more precise (box) rules first. */
  rules?: RegionRule[];
}

export interface RegionPhoto {
  album: string | null;
  latitude: number | null;
  longitude: number | null;
}

/** The region whose species list a photo is matched against: by EXIF position or album name, else the default. */
export function resolveRegion(photo: RegionPhoto, config: RegionsConfig): string {
  const known = (name: string): string => {
    if (!(name in config.regions)) throw new Error(`Unknown species region "${name}" (define it under "regions" in regions.json)`);
    return name;
  };
  for (const rule of config.rules ?? []) {
    const byBox =
      rule.bbox !== undefined &&
      photo.latitude != null &&
      photo.longitude != null &&
      photo.latitude >= rule.bbox[0] &&
      photo.latitude <= rule.bbox[2] &&
      photo.longitude >= rule.bbox[1] &&
      photo.longitude <= rule.bbox[3];
    const byAlbum = rule.albumPattern !== undefined && photo.album != null && new RegExp(rule.albumPattern, 'i').test(photo.album);
    if (byBox || byAlbum) return known(rule.region);
  }
  return known(config.default);
}

/** "Genus species" from a GBIF scientific name (authors and subspecies dropped); null when it is not a species. */
export function normalizeBinomial(name: string): string | null {
  const [genus, epithet] = name.trim().split(/\s+/);
  if (!genus || !epithet) return null;
  return /^[A-Z][a-z-]+$/.test(genus) && /^[a-z-]+$/.test(epithet) && epithet !== 'x' ? `${genus} ${epithet}` : null;
}

/** GBIF taxon keys: birds, mammals, amphibians. Reptiles have no usable key in the occurrence facet, so they are never filtered. */
const CLASSES = [212, 359, 131];

export function regionFilePath(dir: string, region: string): string {
  return path.join(dir, `${region}.json`);
}

/**
 * Builds the list of species GBIF has records for in a region (country, optionally one state) and saves it
 * as `<dir>/<region>.json` for the species sidecar. Only the region name is sent to GBIF, never anything
 * about the photos. Throws, writing nothing, if GBIF fails or returns no species.
 */
export async function buildRegionFile(
  region: string,
  def: RegionDef,
  dir: string,
  fetchFn: typeof fetch = fetch
): Promise<string> {
  const species = new Set<string>();
  for (const taxonKey of CLASSES) {
    const url = new URL('https://api.gbif.org/v1/occurrence/search');
    url.searchParams.set('country', def.country);
    if (def.stateProvince) url.searchParams.set('stateProvince', def.stateProvince);
    url.searchParams.set('taxonKey', String(taxonKey));
    url.searchParams.set('hasCoordinate', 'true');
    url.searchParams.set('limit', '0');
    url.searchParams.set('facet', 'scientificName');
    url.searchParams.set('facetLimit', '30000');
    const response = await fetchFn(url.toString(), { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`GBIF request failed: ${response.status}`);
    const body = (await response.json()) as { facets?: { counts?: { name: string }[] }[] };
    for (const c of body.facets?.[0]?.counts ?? []) {
      const binomial = normalizeBinomial(c.name);
      if (binomial) species.add(binomial);
    }
  }
  if (species.size === 0) throw new Error(`GBIF returned no species for region ${region}`);

  await mkdir(dir, { recursive: true });
  const file = regionFilePath(dir, region);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify({ region, builtAt: new Date().toISOString(), species: [...species].sort() }));
  await rename(tmp, file);
  return file;
}

/** Reads regions.json (the committed config). */
export async function loadRegionsConfig(file: string): Promise<RegionsConfig> {
  return JSON.parse(await readFile(file, 'utf8')) as RegionsConfig;
}
