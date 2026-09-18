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
    const tempPath = path.join(tempDir, `pixdex-drive-${randomUUID()}-${image.name}`);

    try {
      await downloadDriveFile(driveClient, image.id, tempPath);
      const contentHash = await sha256ContentHash(tempPath);
      const knownHashes = await cloudflareClient.checkHashes([contentHash]);

      if (knownHashes.has(contentHash)) {
        skipped++;
        onProgress?.(`Skipping already-indexed: ${image.name}`);
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
      onProgress?.(`Indexed: ${image.name}`);
    } catch (error) {
      failed++;
      onProgress?.(`Failed: ${image.name} (${error instanceof Error ? error.message : String(error)})`);
    } finally {
      await rm(tempPath, { force: true });
    }
  }

  return { total: images.length, indexed, skipped, failed };
}
