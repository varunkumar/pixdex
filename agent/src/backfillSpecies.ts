import { readFile } from 'node:fs/promises';
import type { CloudflareClient, PendingSpeciesPhoto, SpeciesEntry } from './cloudflareClient';
import { identifySpecies } from './species/identify';
import type { RegionsConfig } from './species/regions';
import type { SpeciesSidecarClient } from './species/sidecarClient';

export interface BackfillSpeciesResult {
  total: number;
  scanned: number;
  /** Scanned photos where at least one species was confident enough to store. */
  withSpecies: number;
  /** Local photos whose file is not on disk right now (drive not mounted, file moved). */
  missing: number;
  /** Google Drive photos skipped because the agent has no Drive login. */
  skippedDrive: number;
  /** Photos the Worker no longer knows by content hash. */
  notIndexed: number;
  failed: number;
}

const DEFAULT_BATCH = 25;
const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Finds the species in photos that are already indexed. The Worker says which photos (local or Google
 * Drive) still need a scan with the sidecar's model, so this never walks folders; a re-run only does what
 * is left. A photo is stored as scanned even when nothing was confident (an empty list), so it is not
 * looked at again. A photo that fails, or whose file cannot be opened, is not stored and stays pending.
 * Results are written to the Worker in batches of `batchSize`.
 */
export async function backfillSpecies(deps: {
  cloudflareClient: Pick<CloudflareClient, 'speciesPending' | 'ingestSpecies'>;
  sidecar: Pick<SpeciesSidecarClient, 'model' | 'identify'>;
  regions: RegionsConfig;
  /** Reads a Google Drive file's bytes; absent means Drive photos are skipped. */
  openDriveFile?: (fileId: string) => Promise<Buffer>;
  /** Limit to these album names; absent means every album with pending photos. */
  albums?: string[];
  /** Stop after this many photos have been looked at. */
  limit?: number;
  /** Identify and report, but write nothing. */
  dryRun?: boolean;
  batchSize?: number;
  onProgress?: (message: string) => void;
}): Promise<BackfillSpeciesResult> {
  const { cloudflareClient, sidecar, regions, openDriveFile, albums, limit, dryRun, onProgress } = deps;
  const batchSize = deps.batchSize ?? DEFAULT_BATCH;
  const result: BackfillSpeciesResult = { total: 0, scanned: 0, withSpecies: 0, missing: 0, skippedDrive: 0, notIndexed: 0, failed: 0 };
  const model = await sidecar.model();

  let batch: { contentHash: string; species: SpeciesEntry[] }[] = [];
  const flush = async () => {
    if (batch.length === 0 || dryRun) {
      batch = [];
      return;
    }
    const sent = batch;
    batch = [];
    const { unknown } = await cloudflareClient.ingestSpecies(model, sent);
    result.notIndexed += unknown;
  };

  let consecutiveFailures = 0;
  const handle = async (item: PendingSpeciesPhoto): Promise<void> => {
    result.total++;
    const label = item.album ? `${item.album} / ${item.filename}` : item.filename;
    let original: Buffer;
    if (item.source === 'google_drive') {
      if (!openDriveFile || !item.driveFileId) {
        result.skippedDrive++;
        return;
      }
      try {
        original = await openDriveFile(item.driveFileId);
      } catch (error) {
        result.failed++;
        onProgress?.(`Failed: ${label} (Drive: ${error instanceof Error ? error.message : String(error)})`);
        return;
      }
    } else {
      try {
        original = await readFile(item.path as string);
      } catch {
        result.missing++;
        return;
      }
    }

    try {
      const { region, species } = await identifySpecies(original, item, { sidecar, regions });
      consecutiveFailures = 0;
      result.scanned++;
      if (species.length > 0) result.withSpecies++;
      batch.push({ contentHash: item.contentHash, species });
      onProgress?.(`${dryRun ? 'Would store' : 'Scanned'} (${species.map((s) => `${s.common} ${s.score}`).join(', ') || 'no species'}) [${region}]: ${label}`);
      if (batch.length >= batchSize) await flush();
    } catch (error) {
      result.failed++;
      consecutiveFailures++;
      onProgress?.(`Failed: ${label} (${error instanceof Error ? error.message : String(error)})`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        await flush();
        throw new Error(`Species scan failed ${MAX_CONSECUTIVE_FAILURES} times in a row (is the species sidecar running?): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  for (const album of albums && albums.length > 0 ? albums : [undefined]) {
    let cursor: number | undefined;
    do {
      const page = await cloudflareClient.speciesPending(model, { cursor, album });
      for (const item of page.items) {
        if (limit !== undefined && result.total >= limit) break;
        await handle(item);
      }
      cursor = limit !== undefined && result.total >= limit ? undefined : (page.nextCursor ?? undefined);
    } while (cursor !== undefined);
    if (limit !== undefined && result.total >= limit) break;
  }
  await flush();
  return result;
}
