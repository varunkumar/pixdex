import { sha256ContentHash } from './hashing';
import type { OllamaClient } from './ollama/client';
import { ratePhoto } from './ollama/ratePhoto';
import { isImageFile, scanDirectory } from './scanner';
import type { CloudflareClient } from './cloudflareClient';

export interface BackfillRatingsResult {
  total: number;
  rated: number;
  notIndexed: number;
  unrated: number;
  failed: number;
}

/**
 * Rates already-indexed photos for visual quality and gives them a 3-4 word
 * caption, writing both onto their rows (matched by content hash). One short
 * vision call per photo; safe to re-run (it overwrites the previous values).
 */
export async function backfillRatings(
  folder: string,
  deps: { cloudflareClient: CloudflareClient; ollamaClient: OllamaClient; onProgress?: (message: string) => void }
): Promise<BackfillRatingsResult> {
  const { cloudflareClient, ollamaClient, onProgress } = deps;
  const files = (await scanDirectory(folder)).filter(isImageFile);
  const result: BackfillRatingsResult = { total: files.length, rated: 0, notIndexed: 0, unrated: 0, failed: 0 };

  const hashes = await Promise.all(files.map((f) => sha256ContentHash(f).catch(() => null)));
  const known = await cloudflareClient.checkHashes(hashes.filter((h): h is string => h !== null));

  for (const [i, file] of files.entries()) {
    const hash = hashes[i];
    try {
      if (!hash) throw new Error('could not hash file');
      if (!known.has(hash)) {
        result.notIndexed++;
        onProgress?.(`Not indexed yet: ${file}`);
        continue;
      }
      const { score, caption } = await ratePhoto(file, ollamaClient);
      if (score === null && caption === null) {
        result.unrated++;
        onProgress?.(`Nothing usable from the model: ${file}`);
        continue;
      }
      await cloudflareClient.updateRating(hash, {
        ...(score !== null && { score }),
        ...(caption !== null && { shortCaption: caption }),
      });
      result.rated++;
      onProgress?.(`Rated ${score ?? '-'} "${caption ?? ''}": ${file}`);
    } catch (error) {
      result.failed++;
      onProgress?.(`Failed: ${file} (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  return result;
}
