import { access } from 'node:fs/promises';
import { PhotoNotIndexedError, scanFaces } from './faces/scanFaces';
import type { CloudflareClient } from './cloudflareClient';
import type { FaceSidecarClient } from './faces/sidecarClient';

export interface BackfillFacesResult {
  total: number;
  scanned: number;
  faces: number;
  /** Indexed photos whose file is not on disk right now (drive not mounted, file moved). */
  missing: number;
  notIndexed: number;
  failed: number;
}

/**
 * Detects faces in photos that are already indexed. The Worker says which local
 * photos still need a scan with the sidecar's model (and where they live), so
 * this never walks folders or hashes files, and a re-run only does what is left.
 * `pathPrefix` limits it to one folder.
 */
export async function backfillFaces(deps: {
  cloudflareClient: CloudflareClient;
  sidecar: FaceSidecarClient;
  pathPrefix?: string;
  /** Also re-scan photos that have a face without a sharp crop (faces scanned before crops existed). */
  missingCrops?: boolean;
  onProgress?: (message: string) => void;
}): Promise<BackfillFacesResult> {
  const { cloudflareClient, sidecar, pathPrefix, missingCrops, onProgress } = deps;
  const result: BackfillFacesResult = { total: 0, scanned: 0, faces: 0, missing: 0, notIndexed: 0, failed: 0 };
  const model = await sidecar.model();

  let cursor: number | undefined;
  do {
    const page = await cloudflareClient.facesUnscanned(model, { cursor, pathPrefix, missingCrops });
    for (const { contentHash, path: file } of page.items) {
      result.total++;
      try {
        await access(file);
      } catch {
        result.missing++;
        continue;
      }
      try {
        const count = await scanFaces(file, contentHash, { sidecar, cloudflareClient });
        result.scanned++;
        result.faces += count;
        onProgress?.(`Scanned (${count} faces): ${file}`);
      } catch (error) {
        if (error instanceof PhotoNotIndexedError) {
          result.notIndexed++;
          onProgress?.(`Not indexed yet: ${file}`);
        } else {
          result.failed++;
          onProgress?.(`Failed: ${file} (${error instanceof Error ? error.message : String(error)})`);
        }
      }
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);

  return result;
}
