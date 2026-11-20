import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extractExifData } from './exif';
import { generateThumbnail } from './thumbnail';
import { analyzeImage, type ImageAnalysisResult } from './ollama/analyzeImage';
import { ratePhoto } from './ollama/ratePhoto';
import { generateText } from './ollama/generateText';
import type { OllamaClient } from './ollama/client';
import { CloudflareClient, type IngestPhotoPayload, type SpeciesEntry } from './cloudflareClient';
import type { AgentConfig } from './config';
import { prepareFaceImage, scanFaces } from './faces/scanFaces';
import type { Gallery } from './known/gallery';
import type { FaceSidecarClient } from './faces/sidecarClient';
import { detectSpecies, type SpeciesDeps } from './species/identify';
import { decideSpecies } from './species/decide';

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
  /** Face scanning runs after ingest when set; a failure never fails the photo. */
  faceSidecar?: FaceSidecarClient;
  knownGallery?: Gallery;
  /** Species identification runs before ingest when set; a failure never fails the photo (backfill-species picks it up). */
  species?: SpeciesDeps;
}

/** Milliseconds spent in each stage of one photo, for measuring where indexing time goes. */
export interface StageTimings {
  exif: number;
  analyze: number;
  rate: number;
  caption: number;
  hashtags: number;
  thumbnail: number;
  species: number;
  ingest: number;
  faces: number;
}

export async function processFile(input: ProcessFileInput, deps: ProcessFileDeps): Promise<StageTimings> {
  const { cloudflareClient, ollamaClient, config } = deps;
  const timings: StageTimings = { exif: 0, analyze: 0, rate: 0, caption: 0, hashtags: 0, thumbnail: 0, species: 0, ingest: 0, faces: 0 };
  const timed = async <T>(stage: keyof StageTimings, run: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    try {
      return await run();
    } finally {
      timings[stage] += Date.now() - started;
    }
  };
  // Fail before any Ollama work: every photo is indexed on behalf of one album owner.
  const ownerEmail = config.OWNER_EMAIL?.trim().toLowerCase();
  if (!ownerEmail) throw new Error('OWNER_EMAIL must be set in agent/.env to index photos (the album owner)');

  const exif = await timed('exif', () => extractExifData(input.localPath));

  // The face and species sidecars need only the picture (species also the region, from EXIF and album),
  // not the vision model's words, so they start now and run while the model works. Their time is
  // counted in `faces` and `species` even though it overlaps `analyze`, so stage times can add up to
  // more than the wall time. A failure is held and handled at the same place as before.
  const faceDetection = deps.faceSidecar
    ? timed('faces', async () => deps.faceSidecar!.detect(await prepareFaceImage(input.localPath)))
    : undefined;
  const speciesDetection = deps.species
    ? timed('species', async () =>
        detectSpecies(
          await readFile(input.localPath),
          { album: input.album ?? null, latitude: exif.camera.latitude ?? null, longitude: exif.camera.longitude ?? null },
          deps.species!
        )
      )
    : undefined;
  // If a model call throws first, these must not become unhandled rejections.
  faceDetection?.catch(() => {});
  speciesDetection?.catch(() => {});

  const analysis = await timed('analyze', () => analyzeImage(input.localPath, ollamaClient, { album: input.album }));
  const rating = await timed('rate', () => ratePhoto(input.localPath, ollamaClient));
  const caption = await timed('caption', () => generateText(buildCaptionPrompt(analysis), ollamaClient));
  const hashtags = await timed('hashtags', () => generateText(buildHashtagPrompt(analysis), ollamaClient));
  const thumbnail = await timed('thumbnail', () => generateThumbnail(input.localPath));
  let found: { model: string; species: SpeciesEntry[] } | undefined;
  if (speciesDetection) {
    try {
      const { detection } = await speciesDetection;
      found = { model: detection.model, species: decideSpecies(detection, { subjects: [...analysis.subjects, ...analysis.tags] }) };
    } catch (error) {
      // The photo is still indexed (species_model stays empty); `backfill-species` will pick this one up.
      console.warn(`Species scan failed: ${input.filename} (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  const payload: IngestPhotoPayload = {
    id: randomUUID(),
    ownerEmail,
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
    ...exif.camera,
    hasWatermark: analysis.hasWatermark,
    aestheticScore: rating.score ?? undefined,
    shortCaption: rating.caption ?? undefined,
    ...(found && { species: found.species, speciesModel: found.model }),
  };

  // Upload the thumbnail before creating the D1 row: the thumbnail PUT is
  // safe to retry/duplicate (keyed by content hash), but once ingestPhoto
  // succeeds, future dedup checks skip this hash forever, so we must not
  // create the metadata row until we know the thumbnail landed.
  await timed('ingest', async () => {
    await cloudflareClient.uploadThumbnail(input.contentHash, thumbnail);
    await cloudflareClient.ingestPhoto(payload);
  });

  if (deps.faceSidecar && faceDetection) {
    try {
      await timed('faces', () =>
        scanFaces(input.localPath, input.contentHash, {
          sidecar: deps.faceSidecar!,
          cloudflareClient,
          gallery: deps.knownGallery,
          boxFrame: 'upright',
          detection: faceDetection,
          onWarning: (message) => console.warn(message),
        })
      );
    } catch (error) {
      // The photo is already indexed; `backfill-faces` will pick this one up.
      console.warn(
        `Face scan failed: ${input.filename} (${error instanceof Error ? error.message : String(error)})`
      );
    }
  }
  return timings;
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
