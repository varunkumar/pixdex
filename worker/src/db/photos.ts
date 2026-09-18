import { z } from 'zod';

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
});

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
  last_indexed?: string;
  instagram_suggested?: string | null;
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
}

function parseJsonArray(value: string | undefined | null): unknown[] {
  if (!value) return [];
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

/**
 * Turns a raw D1 photos row (snake_case columns, JSON-encoded array columns
 * stored as text) into the one clean camelCase shape every route returns.
 * Tolerates partial rows (e.g. a SELECT that only projects a subset of
 * columns for cost reasons) by defaulting missing array columns to [].
 */
export function serializePhoto(row: PhotoRow): SerializedPhoto {
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
    subjects: parseJsonArray(row.subjects),
    colors: parseJsonArray(row.colors),
    patterns: parseJsonArray(row.patterns),
    tags: parseJsonArray(row.tags),
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
  };
}

export function buildSearchText(input: {
  subjects: string[];
  tags: string[];
  description: string;
  environment?: string;
  album?: string;
}): string {
  return [
    ...input.subjects,
    ...input.tags,
    input.description,
    input.environment ?? '',
    input.album ?? '',
  ]
    .filter(Boolean)
    .join(' ');
}
