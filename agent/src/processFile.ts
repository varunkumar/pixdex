import { randomUUID } from 'node:crypto';
import { extractExifData } from './exif';
import { generateThumbnail } from './thumbnail';
import { analyzeImage, type ImageAnalysisResult } from './ollama/analyzeImage';
import { generateText } from './ollama/generateText';
import type { OllamaClient } from './ollama/client';
import { CloudflareClient, type IngestPhotoPayload } from './cloudflareClient';
import type { AgentConfig } from './config';

export interface ProcessFileInput {
  localPath: string;
  contentHash: string;
  source: 'local' | 'google_drive';
  sourcePath?: string;
  driveFileId?: string;
  filename: string;
  album?: string;
}

export interface ProcessFileDeps {
  cloudflareClient: CloudflareClient;
  ollamaClient: OllamaClient;
  config: AgentConfig;
}

export async function processFile(input: ProcessFileInput, deps: ProcessFileDeps): Promise<void> {
  const { cloudflareClient, ollamaClient, config } = deps;

  const exif = await extractExifData(input.localPath);
  const analysis = await analyzeImage(input.localPath, ollamaClient);
  const caption = await generateText(buildCaptionPrompt(analysis), ollamaClient);
  const hashtags = await generateText(buildHashtagPrompt(analysis), ollamaClient);
  const thumbnail = await generateThumbnail(input.localPath);

  const payload: IngestPhotoPayload = {
    id: randomUUID(),
    contentHash: input.contentHash,
    source: input.source,
    path: input.sourcePath,
    driveFileId: input.driveFileId,
    filename: input.filename,
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
    album: input.album,
    description: analysis.description,
    suggestedCaption: caption,
    suggestedHashtags: parseHashtagList(hashtags),
    modelProvider: 'ollama',
    modelName: config.OLLAMA_MODEL,
  };

  // Upload the thumbnail before creating the D1 row: the thumbnail PUT is
  // safe to retry/duplicate (keyed by content hash), but once ingestPhoto
  // succeeds, future dedup checks skip this hash forever, so we must not
  // create the metadata row until we know the thumbnail landed.
  await cloudflareClient.uploadThumbnail(input.contentHash, thumbnail);
  await cloudflareClient.ingestPhoto(payload);
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
