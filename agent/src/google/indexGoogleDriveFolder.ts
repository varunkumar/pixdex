import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { listImagesInDriveFolder, downloadDriveFile, type DriveFilesClient } from './driveFiles';
import { sha256ContentHash } from '../hashing';
import { processFile } from '../processFile';
import type { OllamaClient } from '../ollama/client';
import type { CloudflareClient } from '../cloudflareClient';
import type { AgentConfig } from '../config';

export interface IndexGoogleDriveFolderResult {
  total: number;
  indexed: number;
  skipped: number;
  failed: number;
}

export interface IndexGoogleDriveFolderDeps {
  cloudflareClient: CloudflareClient;
  ollamaClient: OllamaClient;
  config: AgentConfig;
  onProgress?: (message: string) => void;
  tempDir?: string;
}

// A throwing `onProgress` callback must not abort the folder-indexing loop
// any more than a failed download/process/cleanup should. Swallow it.
function reportProgress(onProgress: ((message: string) => void) | undefined, message: string): void {
  try {
    onProgress?.(message);
  } catch {
    // ignore: progress reporting is best-effort
  }
}

export async function indexGoogleDriveFolder(
  driveClient: DriveFilesClient,
  folderId: string,
  folderName: string,
  deps: IndexGoogleDriveFolderDeps
): Promise<IndexGoogleDriveFolderResult> {
  const { cloudflareClient, ollamaClient, config, onProgress, tempDir = tmpdir() } = deps;

  const images = await listImagesInDriveFolder(driveClient, folderId);

  let indexed = 0;
  let skipped = 0;
  let failed = 0;

  for (const image of images) {
    // Use only a random UUID (plus the original extension, for format
    // detection) in the temp filename. `image.name` is untrusted input from
    // Drive and may contain path-meaningful characters (e.g. "../"), so it
    // must never be interpolated directly into a filesystem path.
    const tempPath = path.join(tempDir, `pixdex-drive-${randomUUID()}${path.extname(image.name)}`);

    try {
      await downloadDriveFile(driveClient, image.id, tempPath);
      const contentHash = await sha256ContentHash(tempPath);
      const knownHashes = await cloudflareClient.checkHashes([contentHash]);

      if (knownHashes.has(contentHash)) {
        skipped++;
        reportProgress(onProgress, `Skipping already-indexed: ${image.name}`);
        continue;
      }

      await processFile(
        {
          localPath: tempPath,
          contentHash,
          source: 'google_drive',
          driveFileId: image.id,
          filename: image.name,
          album: folderName,
        },
        { cloudflareClient, ollamaClient, config }
      );
      indexed++;
      reportProgress(onProgress, `Indexed: ${image.name}`);
    } catch (error) {
      failed++;
      reportProgress(
        onProgress,
        `Failed: ${image.name} (${error instanceof Error ? error.message : String(error)})`
      );
    } finally {
      // Best-effort cleanup: a locked file, AV scanner, or read-only temp
      // dir can make `rm` reject even with `force: true` (which only
      // suppresses ENOENT). A cleanup failure must never abort the rest of
      // the folder, so it is swallowed here rather than propagated.
      try {
        await rm(tempPath, { force: true });
      } catch (cleanupError) {
        reportProgress(
          onProgress,
          `Cleanup failed for ${image.name} (${
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          })`
        );
      }
    }
  }

  return { total: images.length, indexed, skipped, failed };
}
