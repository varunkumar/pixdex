import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isImageFile, scanDirectory } from './scanner';
import { sha256ContentHash } from './hashing';
import { extractExifData } from './exif';
import { generateThumbnail } from './thumbnail';
import { analyzeImage, type ImageAnalysisResult } from './ollama/analyzeImage';
import { generateText } from './ollama/generateText';
import type { OllamaClient } from './ollama/client';
import { CloudflareClient, type IngestPhotoPayload } from './cloudflareClient';
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

  // Hash each file independently: a single unreadable/dangling file must not
  // abort the whole run. Files whose hash computation fails are counted as
  // failed immediately and excluded from the rest of the pipeline.
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

  // Track content hashes already handled in this run so byte-identical
  // duplicates within the same folder don't get expensively re-analyzed.
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
      const exif = await extractExifData(file);
      const analysis = await analyzeImage(file, ollamaClient);
      const caption = await generateText(buildCaptionPrompt(analysis), ollamaClient);
      const hashtags = await generateText(buildHashtagPrompt(analysis), ollamaClient);
      const thumbnail = await generateThumbnail(file);

      const payload: IngestPhotoPayload = {
        id: randomUUID(),
        contentHash,
        source: 'local',
        path: file,
        filename: path.basename(file),
        dateTime: exif.dateTime,
        width: exif.dimensions.width,
        height: exif.dimensions.height,
        format: exif.format,
        fileSize: exif.size,
        subjects: analysis.subjects,
        colors: analysis.colors,
        patterns: analysis.patterns,
        tags: analysis.tags,
        season: analysis.season,
        environment: analysis.environment,
        description: analysis.description,
        suggestedCaption: caption,
        suggestedHashtags: parseHashtagList(hashtags),
        modelProvider: 'ollama',
        modelName: config.OLLAMA_MODEL,
      };

      // Upload the thumbnail before creating the D1 row: the thumbnail PUT is
      // safe to retry/duplicate (keyed by content hash), but once ingestPhoto
      // succeeds, future runs' dedup check will skip this file forever, so we
      // must not create the metadata row until we know the thumbnail landed.
      await cloudflareClient.uploadThumbnail(contentHash, thumbnail);
      await cloudflareClient.ingestPhoto(payload);
      indexed++;
      onProgress?.(`Indexed: ${file}`);
    } catch (error) {
      failed++;
      onProgress?.(`Failed: ${file} (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  return { total: imageFiles.length, indexed, skipped, failed };
}

function buildCaptionPrompt(analysis: ImageAnalysisResult): string {
  return `Generate an engaging Instagram caption for this wildlife photo using these details:
Subject: ${analysis.subjects.join(', ')}
Environment: ${analysis.environment ?? 'Not specified'}
Description: ${analysis.description}
Season: ${analysis.season ?? 'Not specified'}

Make it engaging, informative, include an interesting fact, end with a question, and keep it under 200 characters.`;
}

function buildHashtagPrompt(analysis: ImageAnalysisResult): string {
  return `Generate up to 15 relevant Instagram hashtags for this wildlife photo, comma-separated, no # symbol:
Subjects: ${analysis.subjects.join(', ')}
Environment: ${analysis.environment ?? 'Not specified'}
Colors: ${analysis.colors.join(', ')}
Season: ${analysis.season ?? 'Not specified'}`;
}

function parseHashtagList(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((tag) => tag.trim().replace(/[^a-zA-Z0-9_]/g, ''))
    .filter((tag) => tag.length > 0 && tag.length <= 30);
}
