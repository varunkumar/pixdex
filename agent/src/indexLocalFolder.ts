import path from 'node:path';
import { isImageFile, scanDirectory } from './scanner';
import { sha256ContentHash } from './hashing';
import { processFile } from './processFile';
import type { OllamaClient } from './ollama/client';
import type { CloudflareClient } from './cloudflareClient';
import type { AgentConfig } from './config';

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
  onProgress?: (message: string) => void;
}

export async function indexLocalFolder(
  folder: string,
  deps: IndexLocalFolderDeps
): Promise<IndexLocalFolderResult> {
  const { cloudflareClient, ollamaClient, config, onProgress } = deps;

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
      onProgress?.(
        `Failed: ${imageFiles[i]} (${reason instanceof Error ? reason.message : String(reason)})`
      );
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
      continue;
    }
    if (processedHashes.has(contentHash)) {
      skipped++;
      onProgress?.(`Skipping duplicate content in this run: ${file}`);
      continue;
    }
    processedHashes.add(contentHash);

    try {
      await processFile(
        { localPath: file, contentHash, source: 'local', sourcePath: file, filename: path.basename(file) },
        { cloudflareClient, ollamaClient, config }
      );
      indexed++;
      onProgress?.(`Indexed: ${file}`);
    } catch (error) {
      failed++;
      onProgress?.(`Failed: ${file} (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  return { total: imageFiles.length, indexed, skipped, failed };
}
