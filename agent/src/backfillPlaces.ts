import type { CloudflareClient } from './cloudflareClient';
import { nearestTown, type Gazetteer } from './places/gazetteer';

export interface BackfillPlacesResult {
  total: number;
  placed: number;
  /** Photos with no town near them; stored as '' so that they are not looked at again. */
  none: number;
  /** Photos the Worker no longer knows by content hash. */
  notIndexed: number;
}

const PAGE = 100;

/**
 * Gives a town name to every indexed photo that has a GPS position and no place yet. The Worker says which
 * photos, so no photo file is opened; a re-run only does what is left.
 */
export async function backfillPlaces(deps: {
  cloudflareClient: Pick<CloudflareClient, 'placesPending' | 'ingestPlaces'>;
  gazetteer: Gazetteer;
  dryRun?: boolean;
  onProgress?: (message: string) => void;
}): Promise<BackfillPlacesResult> {
  const { cloudflareClient, gazetteer, dryRun, onProgress } = deps;
  const result: BackfillPlacesResult = { total: 0, placed: 0, none: 0, notIndexed: 0 };
  let cursor: number | null = 0;
  while (cursor !== null) {
    const page: Awaited<ReturnType<CloudflareClient['placesPending']>> = await cloudflareClient.placesPending(cursor, PAGE);
    const photos = page.items.map((p) => ({ contentHash: p.contentHash, place: nearestTown(gazetteer, p.latitude, p.longitude) }));
    result.total += photos.length;
    result.placed += photos.filter((p) => p.place).length;
    result.none += photos.filter((p) => !p.place).length;
    if (photos.length > 0 && !dryRun) result.notIndexed += (await cloudflareClient.ingestPlaces(photos)).unknown;
    if (photos.length > 0) onProgress?.(`${result.total} photos: ${result.placed} with a town, ${result.none} with none`);
    cursor = page.nextCursor;
  }
  return result;
}
