import sharp from 'sharp';
import type { RegionPhoto, RegionsConfig } from './regions';
import { resolveRegion } from './regions';
import { decideSpecies, type SpeciesDetection } from './decide';
import type { SpeciesEntry } from '../cloudflareClient';
import type { SpeciesSidecarClient } from './sidecarClient';

/** The long side the sidecar gets: enough for a small bird, and what the thresholds were tuned on. */
export const SPECIES_MAX_SIDE = 1600;

export interface SpeciesDeps {
  sidecar: Pick<SpeciesSidecarClient, 'identify'>;
  regions: RegionsConfig;
}

/** The slow half: the sidecar call. It needs only the picture and the region, not the vision model's words. */
export async function detectSpecies(
  original: Buffer,
  photo: RegionPhoto,
  deps: SpeciesDeps
): Promise<{ detection: SpeciesDetection; region: string }> {
  const jpeg = await sharp(original)
    .rotate()
    .resize({ width: SPECIES_MAX_SIDE, height: SPECIES_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
  const region = resolveRegion(photo, deps.regions);
  return { detection: await deps.sidecar.identify(jpeg, region), region };
}

/**
 * Identifies the species in one photo: a downsized, upright JPEG goes to the sidecar with the region
 * (from the photo's position or album), and the policy chooses what to keep. Shared by the backfill
 * and by indexing new photos. Throws if the image cannot be decoded or the sidecar fails.
 */
export async function identifySpecies(
  original: Buffer,
  photo: RegionPhoto & { subjects?: string[] },
  deps: SpeciesDeps
): Promise<{ model: string; region: string; species: SpeciesEntry[] }> {
  const { detection, region } = await detectSpecies(original, photo, deps);
  return { model: detection.model, region, species: decideSpecies(detection, { subjects: photo.subjects }) };
}
