import { sha256ContentHash } from './hashing';
import { isImageFile, scanDirectory } from './scanner';
import { PhotoNotIndexedError, scanFaces } from './faces/scanFaces';
import type { CloudflareClient } from './cloudflareClient';
import type { FaceSidecarClient } from './faces/sidecarClient';

const PENDING_BATCH_SIZE = 100;

export interface BackfillFacesResult {
  total: number;
  scanned: number;
  faces: number;
  skipped: number;
  notIndexed: number;
  failed: number;
}

/**
 * Detects faces in files that are already indexed. Asks the Worker which
 * hashes still need a scan with the sidecar's model, so a re-run skips
 * everything already scanned. Files that are not indexed yet are never
 * pending, so they count as skipped.
 */
export async function backfillFaces(
  folder: string,
  deps: {
    cloudflareClient: CloudflareClient;
    sidecar: FaceSidecarClient;
    onProgress?: (message: string) => void;
  }
): Promise<BackfillFacesResult> {
  const { cloudflareClient, sidecar, onProgress } = deps;
  const files = (await scanDirectory(folder)).filter(isImageFile);
  const result: BackfillFacesResult = { total: files.length, scanned: 0, faces: 0, skipped: 0, notIndexed: 0, failed: 0 };
  const model = await sidecar.model();

  for (let i = 0; i < files.length; i += PENDING_BATCH_SIZE) {
    const batch: { file: string; hash: string }[] = [];
    for (const file of files.slice(i, i + PENDING_BATCH_SIZE)) {
      try {
        batch.push({ file, hash: await sha256ContentHash(file) });
      } catch (error) {
        result.failed++;
        onProgress?.(`Failed: ${file} (${error instanceof Error ? error.message : String(error)})`);
      }
    }

    let pending: Set<string>;
    try {
      pending = await cloudflareClient.facesPending(
        batch.map((b) => b.hash),
        model
      );
    } catch (error) {
      result.failed += batch.length;
      onProgress?.(`Failed: batch at ${i} (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }

    for (const { file, hash } of batch) {
      if (!pending.has(hash)) {
        result.skipped++;
        continue;
      }
      try {
        const count = await scanFaces(file, hash, { sidecar, cloudflareClient });
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
  }

  return result;
}
