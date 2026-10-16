import { z } from 'zod';
import { combinedScore } from './rating';

// Standard camera/EXIF details, stored as first-class columns.
export const exifFieldsSchema = z.object({
  cameraMake: z.string().optional(),
  cameraModel: z.string().optional(),
  lensModel: z.string().optional(),
  focalLength: z.number().optional(),
  fNumber: z.number().optional(),
  exposureTime: z.number().optional(),
  iso: z.number().int().optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});

export type ExifFields = z.infer<typeof exifFieldsSchema>;

export const ingestPhotoSchema = z.object({
  id: z.string().uuid(),
  contentHash: z.string().min(1),
  source: z.enum(['local', 'google_drive']),
  path: z.string().optional(),
  driveFileId: z.string().optional(),
  filename: z.string().min(1),
  dateTime: z.string().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  format: z.string().optional(),
  fileSize: z.number().int().optional(),
  subjects: z.array(z.string()).default([]),
  colors: z.array(z.string()).default([]),
  patterns: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  season: z.string().optional(),
  environment: z.string().optional(),
  album: z.string().optional(),
  description: z.string().default(''),
  suggestedCaption: z.string().default(''),
  suggestedHashtags: z.array(z.string()).default([]),
  modelProvider: z.string().min(1),
  modelName: z.string().min(1),
  // Absent means unknown; the agent sends true/false once it has looked.
  hasWatermark: z.boolean().optional(),
  // 1-10; absent means not rated.
  aestheticScore: z.number().min(1).max(10).optional(),
  // 3-4 word title.
  shortCaption: z.string().max(80).optional(),
}).merge(exifFieldsSchema);

export type IngestPhotoInput = z.infer<typeof ingestPhotoSchema>;

export interface PhotoRow {
  id: string;
  content_hash?: string;
  source?: string;
  path?: string | null;
  drive_file_id?: string | null;
  filename?: string;
  date_time?: string | null;
  width?: number | null;
  height?: number | null;
  format?: string | null;
  file_size?: number | null;
  subjects?: string;
  colors?: string;
  patterns?: string;
  tags?: string;
  season?: string | null;
  environment?: string | null;
  album?: string | null;
  description?: string;
  suggested_caption?: string;
  suggested_hashtags?: string;
  model_provider?: string;
  model_name?: string;
  search_text?: string;
  search_primary?: string;
  last_indexed?: string;
  instagram_suggested?: string | null;
  camera_make?: string | null;
  camera_model?: string | null;
  lens_model?: string | null;
  focal_length?: number | null;
  f_number?: number | null;
  exposure_time?: number | null;
  iso?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  has_watermark?: number | null;
  aesthetic_score?: number | null;
  short_caption?: string | null;
  user_rating?: number | null;
  user_caption?: string | null;
  user_subjects?: string | null;
  user_tags?: string | null;
  [key: string]: unknown;
}

export interface SerializedPhoto {
  id: string;
  contentHash?: string;
  source?: string;
  path: string | null;
  driveFileId: string | null;
  filename?: string;
  dateTime: string | null;
  width: number | null;
  height: number | null;
  format: string | null;
  fileSize: number | null;
  subjects: unknown[];
  colors: unknown[];
  patterns: unknown[];
  tags: unknown[];
  season: string | null;
  environment: string | null;
  album: string | null;
  description?: string;
  suggestedCaption?: string;
  suggestedHashtags: unknown[];
  modelProvider?: string;
  modelName?: string;
  lastIndexed?: string;
  instagramSuggested: string | null;
  thumbnailUrl?: string;
  cameraMake: string | null;
  cameraModel: string | null;
  lensModel: string | null;
  focalLength: number | null;
  fNumber: number | null;
  exposureTime: number | null;
  iso: number | null;
  latitude: number | null;
  longitude: number | null;
  /** null when unknown (indexed before watermark detection existed). */
  hasWatermark: boolean | null;
  /** 1-10 vision-model rating; null when not rated yet. */
  aestheticScore: number | null;
  /** 3-4 word title; null when not generated yet. */
  shortCaption: string | null;
  /** Owner's 1-5 star rating; null when not rated by hand. */
  userRating: number | null;
  /** 1-10 blend of the owner's rating and the model's score; null when neither exists. */
  combinedScore: number | null;
  /** What the owner changed. A null field is not overridden; subjects/tags/shortCaption above hold the effective values. */
  overrides: { shortCaption: string | null; subjects: unknown[] | null; tags: unknown[] | null };
}

function parseJsonArray(value: string | undefined | null): unknown[] {
  if (!value) return [];
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

function parseOverrideArray(value: string | undefined | null): unknown[] | null {
  return value == null ? null : parseJsonArray(value);
}

/** The values to show and index: the owner's override when set, else the model's. */
export function effectiveText(row: PhotoRow) {
  return {
    subjects: (parseOverrideArray(row.user_subjects) ?? parseJsonArray(row.subjects)) as string[],
    tags: (parseOverrideArray(row.user_tags) ?? parseJsonArray(row.tags)) as string[],
    shortCaption: row.user_caption ?? row.short_caption ?? null,
  };
}

/** search_primary: the high-signal words that get extra weight in ranking. */
export function buildPrimaryText(input: {
  subjects: string[];
  tags: string[];
  colors?: string[];
  shortCaption?: string;
}): string {
  return [...input.subjects, ...input.tags, ...(input.colors ?? []), input.shortCaption ?? '']
    .filter(Boolean)
    .join(' ');
}

/** search_primary rebuilt from a full row, honouring overrides. */
export function primaryTextForRow(row: PhotoRow): string {
  const eff = effectiveText(row);
  return buildPrimaryText({
    subjects: eff.subjects,
    tags: eff.tags,
    colors: parseJsonArray(row.colors) as string[],
    shortCaption: eff.shortCaption ?? undefined,
  });
}

/** search_text rebuilt from a full row, honouring overrides. */
export function searchTextForRow(row: PhotoRow): string {
  const eff = effectiveText(row);
  return buildSearchText({
    subjects: eff.subjects,
    tags: eff.tags,
    colors: parseJsonArray(row.colors) as string[],
    patterns: parseJsonArray(row.patterns) as string[],
    season: row.season ?? undefined,
    shortCaption: eff.shortCaption ?? undefined,
    description: row.description ?? '',
    environment: row.environment ?? undefined,
    album: row.album ?? undefined,
    cameraMake: row.camera_make ?? undefined,
    cameraModel: row.camera_model ?? undefined,
    lensModel: row.lens_model ?? undefined,
  });
}

/**
 * Turns a raw D1 photos row (snake_case columns, JSON-encoded array columns
 * stored as text) into the one clean camelCase shape every route returns.
 * Tolerates partial rows (e.g. a SELECT that only projects a subset of
 * columns for cost reasons) by defaulting missing array columns to [].
 */
export function serializePhoto(row: PhotoRow): SerializedPhoto {
  const eff = effectiveText(row);
  return {
    id: row.id,
    contentHash: row.content_hash,
    source: row.source,
    path: row.path ?? null,
    driveFileId: row.drive_file_id ?? null,
    filename: row.filename,
    dateTime: row.date_time ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    format: row.format ?? null,
    fileSize: row.file_size ?? null,
    subjects: eff.subjects,
    colors: parseJsonArray(row.colors),
    patterns: parseJsonArray(row.patterns),
    tags: eff.tags,
    season: row.season ?? null,
    environment: row.environment ?? null,
    album: row.album ?? null,
    description: row.description,
    suggestedCaption: row.suggested_caption,
    suggestedHashtags: parseJsonArray(row.suggested_hashtags),
    modelProvider: row.model_provider,
    modelName: row.model_name,
    lastIndexed: row.last_indexed,
    instagramSuggested: row.instagram_suggested ?? null,
    thumbnailUrl: row.content_hash ? `/thumbnails/${row.content_hash}` : undefined,
    cameraMake: row.camera_make ?? null,
    cameraModel: row.camera_model ?? null,
    lensModel: row.lens_model ?? null,
    focalLength: row.focal_length ?? null,
    fNumber: row.f_number ?? null,
    exposureTime: row.exposure_time ?? null,
    iso: row.iso ?? null,
    latitude: row.latitude ?? null,
    longitude: row.longitude ?? null,
    hasWatermark: row.has_watermark == null ? null : row.has_watermark === 1,
    aestheticScore: row.aesthetic_score ?? null,
    shortCaption: eff.shortCaption,
    userRating: row.user_rating ?? null,
    combinedScore: combinedScore(row),
    overrides: {
      shortCaption: row.user_caption ?? null,
      subjects: parseOverrideArray(row.user_subjects),
      tags: parseOverrideArray(row.user_tags),
    },
  };
}

export function buildSearchText(input: {
  subjects: string[];
  tags: string[];
  description: string;
  environment?: string;
  album?: string;
  cameraMake?: string;
  cameraModel?: string;
  lensModel?: string;
  colors?: string[];
  patterns?: string[];
  season?: string;
  shortCaption?: string;
}): string {
  return [
    ...input.subjects,
    ...input.tags,
    ...(input.colors ?? []),
    ...(input.patterns ?? []),
    input.season ?? '',
    input.shortCaption ?? '',
    input.description,
    input.environment ?? '',
    input.album ?? '',
    input.cameraMake ?? '',
    input.cameraModel ?? '',
    input.lensModel ?? '',
  ]
    .filter(Boolean)
    .join(' ');
}
