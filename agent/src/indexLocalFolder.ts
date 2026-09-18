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
  const hashes = await Promise.all(imageFiles.map((file) => sha256ContentHash(file)));
  const knownHashes = await cloudflareClient.checkHashes(hashes);

  let indexed = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < imageFiles.length; i++) {
    const file = imageFiles[i];
    const contentHash = hashes[i];

    if (knownHashes.has(contentHash)) {
      skipped++;
      onProgress?.(`Skipping already-indexed: ${file}`);
      continue;
    }

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

      await cloudflareClient.ingestPhoto(payload);
      await cloudflareClient.uploadThumbnail(contentHash, thumbnail);
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
