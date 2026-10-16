import path from 'node:path';
import { isImageFile, scanDirectory } from './scanner';
import { sha256ContentHash } from './hashing';
import { processFile } from './processFile';
import type { OllamaClient } from './ollama/client';
import type { CloudflareClient } from './cloudflareClient';
import type { AgentConfig } from './config';
import type { FaceSidecarClient } from './faces/sidecarClient';

export interface IndexLocalFolderResult {
  total: number;
  indexed: number;
  skipped: number;
  failed: number;
}

export interface IndexLocalFolderDeps {
  cloudflareClient: CloudflareClient;
  ollamaClient: OllamaClient;
  config: AgentConfig;
  faceSidecar?: FaceSidecarClient;
  onProgress?: (message: string) => void;
  /** Structured per-file outcome, for callers that track progress durably. */
  onFile?: (event: IndexFileEvent) => void;
}

export interface IndexFileEvent {
  file: string;
  outcome: 'indexed' | 'skipped' | 'failed';
  reason?: string;
}

/**
 * Derives an album name from a photo's path: the folder directly above a
 * "Processed" folder if there is one (".../Bandipur/Processed/x.jpg" ->
 * "Bandipur"), otherwise the photo's own parent folder.
 */
export function albumFromPath(filePath: string): string | undefined {
  const folders = path.dirname(filePath).split(path.sep).filter(Boolean);
  const processedAt = folders.findIndex((name) => name.toLowerCase() === 'processed');
  const album = processedAt > 0 ? folders[processedAt - 1] : folders[folders.length - 1];
  return album || undefined;
}

export async function indexLocalFolder(
  folder: string,
  deps: IndexLocalFolderDeps
): Promise<IndexLocalFolderResult> {
  const { cloudflareClient, ollamaClient, config, faceSidecar, onProgress, onFile } = deps;

  const allFiles = await scanDirectory(folder);
  const imageFiles = allFiles.filter(isImageFile);

  let indexed = 0;
  let skipped = 0;
  let failed = 0;

  const hashResults = await Promise.allSettled(imageFiles.map((file) => sha256ContentHash(file)));

  const hashedFiles: string[] = [];
  const hashedValues: string[] = [];
  for (let i = 0; i < imageFiles.length; i++) {
    const result = hashResults[i];
    if (result.status === 'fulfilled') {
      hashedFiles.push(imageFiles[i]);
      hashedValues.push(result.value);
    } else {
      failed++;
      const reason = result.reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      onProgress?.(`Failed: ${imageFiles[i]} (${message})`);
      onFile?.({ file: imageFiles[i], outcome: 'failed', reason: message });
    }
  }

  const knownHashes = await cloudflareClient.checkHashes(hashedValues);
  const processedHashes = new Set<string>();

  for (let i = 0; i < hashedFiles.length; i++) {
    const file = hashedFiles[i];
    const contentHash = hashedValues[i];

    if (knownHashes.has(contentHash)) {
      skipped++;
      onProgress?.(`Skipping already-indexed: ${file}`);
      onFile?.({ file, outcome: 'skipped' });
      continue;
    }
    if (processedHashes.has(contentHash)) {
      skipped++;
      onProgress?.(`Skipping duplicate content in this run: ${file}`);
      onFile?.({ file, outcome: 'skipped' });
      continue;
    }
    processedHashes.add(contentHash);

    try {
      await processFile(
        {
          localPath: file,
          contentHash,
          source: 'local',
          sourcePath: file,
          filename: path.basename(file),
          album: albumFromPath(file),
        },
        { cloudflareClient, ollamaClient, config, faceSidecar }
      );
      indexed++;
      onProgress?.(`Indexed: ${file}`);
      onFile?.({ file, outcome: 'indexed' });
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message : String(error);
      onProgress?.(`Failed: ${file} (${message})`);
      onFile?.({ file, outcome: 'failed', reason: message });
    }
  }

  return { total: imageFiles.length, indexed, skipped, failed };
}
