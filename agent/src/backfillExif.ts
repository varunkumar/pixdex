import { extractCameraExif } from './exif';
import { sha256ContentHash } from './hashing';
import { isImageFile, scanDirectory } from './scanner';
import type { CloudflareClient } from './cloudflareClient';

export interface BackfillExifResult {
  total: number;
  updated: number;
  notIndexed: number;
  failed: number;
}

/**
 * Re-reads camera/EXIF details from files that are already indexed and writes
 * them onto the existing rows (matched by content hash). No vision model call,
 * so it is fast and safe to re-run.
 */
export async function backfillExif(
  folder: string,
  deps: { cloudflareClient: CloudflareClient; onProgress?: (message: string) => void }
): Promise<BackfillExifResult> {
  const { cloudflareClient, onProgress } = deps;
  const files = (await scanDirectory(folder)).filter(isImageFile);
  const result: BackfillExifResult = { total: files.length, updated: 0, notIndexed: 0, failed: 0 };

  for (const file of files) {
    try {
      const contentHash = await sha256ContentHash(file);
      const camera = await extractCameraExif(file);
      if (await cloudflareClient.updateExif(contentHash, camera)) {
        result.updated++;
        onProgress?.(`Updated: ${file}`);
      } else {
        result.notIndexed++;
        onProgress?.(`Not indexed yet: ${file}`);
      }
    } catch (error) {
      result.failed++;
      onProgress?.(`Failed: ${file} (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  return result;
}
