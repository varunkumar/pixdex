import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface Town {
  name: string;
  lat: number;
  lon: number;
}

/** Towns by whole-degree cell, so a lookup only measures the towns around a position. */
export type Gazetteer = Map<string, Town[]>;

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** GeoNames `cities500` (CC BY 4.0), downloaded by hand and not committed (override with GEONAMES_FILE). */
export const defaultGazetteerFile = () => process.env.GEONAMES_FILE || path.resolve(HERE, '../../.index-state/geonames/cities500.txt');

const KM_PER_DEGREE = 111.32;
const cell = (lat: number, lon: number) => `${lat}:${((((lon + 180) % 360) + 360) % 360) - 180}`;

/** GeoNames tab-separated text: column 1 is the name, 4 latitude, 5 longitude, 8 country (counted from 0). */
export function parseGazetteer(text: string): Gazetteer {
  const gazetteer: Gazetteer = new Map();
  for (const line of text.split('\n')) {
    const c = line.split('\t');
    const lat = Number(c[4]);
    const lon = Number(c[5]);
    if (!c[1] || !c[8] || !c[4] || !c[5] || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const key = cell(Math.floor(lat), Math.floor(lon));
    const towns = gazetteer.get(key);
    const town = { name: `${c[1]}, ${c[8]}`, lat, lon };
    if (towns) towns.push(town);
    else gazetteer.set(key, [town]);
  }
  return gazetteer;
}

function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((bLat - aLat) * rad) / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(((bLon - aLon) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** "Town, CC" for the nearest town within `maxKm`, else ''. */
export function nearestTown(gazetteer: Gazetteer, lat: number, lon: number, maxKm = 50): string {
  const latSpan = Math.ceil(maxKm / KM_PER_DEGREE);
  // A degree of longitude shrinks towards the poles, so look through more cells there.
  const shrink = Math.cos((Math.min(89, Math.abs(lat) + latSpan) * Math.PI) / 180);
  const lonSpan = Math.min(180, Math.ceil(maxKm / (KM_PER_DEGREE * shrink)));
  let best = '';
  let bestKm = maxKm;
  for (let y = Math.floor(lat) - latSpan; y <= Math.floor(lat) + latSpan; y++) {
    for (let x = Math.floor(lon) - lonSpan; x <= Math.floor(lon) + lonSpan; x++) {
      for (const town of gazetteer.get(cell(y, x)) ?? []) {
        const km = distanceKm(lat, lon, town.lat, town.lon);
        if (km <= bestKm) {
          best = town.name;
          bestKm = km;
        }
      }
    }
  }
  return best;
}

/** The town list, or undefined when the file is not there. */
export async function loadGazetteer(file = defaultGazetteerFile()): Promise<Gazetteer | undefined> {
  try {
    return parseGazetteer(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
