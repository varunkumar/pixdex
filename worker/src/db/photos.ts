import * as z from 'zod/mini';
import { combinedScore } from './rating';

// Standard camera/EXIF details, stored as first-class columns.
export const exifFieldsSchema = z.object({
  cameraMake: z.optional(z.string()),
  cameraModel: z.optional(z.string()),
  lensModel: z.optional(z.string()),
  focalLength: z.optional(z.number()),
  fNumber: z.optional(z.number()),
  exposureTime: z.optional(z.number()),
  iso: z.optional(z.int()),
  latitude: z.optional(z.number().check(z.minimum(-90), z.maximum(90))),
  longitude: z.optional(z.number().check(z.minimum(-180), z.maximum(180))),
});

export type ExifFields = z.infer<typeof exifFieldsSchema>;

/** One animal found in a photo by the agent's species model. box is [x0, y0, x1, y1] as fractions of the image. */
export const speciesEntrySchema = z.object({
  common: z.string().check(z.minLength(1), z.maxLength(200)),
  scientific: z.string().check(z.minLength(1), z.maxLength(200)),
  score: z.number().check(z.minimum(0), z.maximum(1)),
  box: z.optional(z.tuple([z.number(), z.number(), z.number(), z.number()])),
});
export const speciesListSchema = z.array(speciesEntrySchema).check(z.maxLength(12));
export const speciesModelSchema = z.string().check(z.minLength(1), z.maxLength(60));
export type SpeciesEntry = z.infer<typeof speciesEntrySchema>;

export const ingestPhotoSchema = z.extend(z.object({
  id: z.uuid(),
  /** The album owner the agent indexes for; stamped on the album by the first photo that creates it. */
  ownerEmail: z.string().check(z.trim(), z.toLowerCase(), z.email()),
  contentHash: z.string().check(z.minLength(1)),
  source: z.enum(['local', 'google_drive']),
  path: z.optional(z.string()),
  driveFileId: z.optional(z.string()),
  filename: z.string().check(z.minLength(1)),
  dateTime: z.optional(z.string()),
  width: z.optional(z.int()),
  height: z.optional(z.int()),
  format: z.optional(z.string()),
  fileSize: z.optional(z.int()),
  subjects: z._default(z.array(z.string()), []),
  colors: z._default(z.array(z.string()), []),
  patterns: z._default(z.array(z.string()), []),
  tags: z._default(z.array(z.string()), []),
  season: z.optional(z.string()),
  environment: z.optional(z.string()),
  album: z.optional(z.string()),
  description: z._default(z.string(), ''),
  suggestedCaption: z._default(z.string(), ''),
  suggestedHashtags: z._default(z.array(z.string()), []),
  modelProvider: z.string().check(z.minLength(1)),
  modelName: z.string().check(z.minLength(1)),
  // Absent means unknown; the agent sends true/false once it has looked.
  hasWatermark: z.optional(z.boolean()),
  // 1-10; absent means not rated.
  aestheticScore: z.optional(z.number().check(z.minimum(1), z.maximum(10))),
  // 3-4 word title.
  shortCaption: z.optional(z.string().check(z.maxLength(80))),
  // Species found by the agent's model; absent keeps what the photo already has.
  species: z.optional(speciesListSchema),
  speciesModel: z.optional(speciesModelSchema),
}), exifFieldsSchema.shape);

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
  species?: string;
  species_model?: string | null;
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
  /** Animals found by the species model ({ common, scientific, score, box? }); [] when none or not scanned. */
  species: unknown[];
  /** Owner's 1-5 star rating; null when not rated by hand. */
  userRating: number | null;
  /** 1-10 blend of the owner's rating and the model's score; null when neither exists. */
  combinedScore: number | null;
  /** Whether the signed-in user may edit this photo (owns its album). */
  canEdit: boolean;
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

/**
 * The names of the animals the species model found, to be indexed. Empty when the owner has set
 * their own subjects: their words are what is searched, so a corrected species can never be
 * contradicted by the model's guess (the species stay stored and shown).
 */
export function speciesWords(species: unknown[], userSubjects: string | null | undefined): string[] {
  if (userSubjects != null) return [];
  const words: string[] = [];
  for (const e of species as Partial<SpeciesEntry>[]) {
    if (e?.common) words.push(e.common);
    if (e?.scientific) words.push(e.scientific);
  }
  return words;
}

/** search_primary: the high-signal words that get extra weight in ranking (species names are the strongest). */
export function buildPrimaryText(input: {
  subjects: string[];
  tags: string[];
  colors?: string[];
  shortCaption?: string;
  species?: string[];
}): string {
  return [...(input.species ?? []), ...input.subjects, ...input.tags, ...(input.colors ?? []), input.shortCaption ?? '']
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
    species: speciesWords(parseJsonArray(row.species), row.user_subjects),
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
    species: speciesWords(parseJsonArray(row.species), row.user_subjects),
  });
}

/**
 * Turns a raw D1 photos row (snake_case columns, JSON-encoded array columns
 * stored as text) into the one clean camelCase shape every route returns.
 * Tolerates partial rows (e.g. a SELECT that only projects a subset of
 * columns for cost reasons) by defaulting missing array columns to [].
 */
export function serializePhoto(row: PhotoRow, canEdit: boolean): SerializedPhoto {
  const eff = effectiveText(row);
  return {
    id: row.id,
    contentHash: row.content_hash,
    source: row.source,
    // The owner's local path and Drive file id never reach viewers (they cannot use either).
    path: canEdit ? (row.path ?? null) : null,
    driveFileId: canEdit ? (row.drive_file_id ?? null) : null,
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
    species: parseJsonArray(row.species),
    userRating: row.user_rating ?? null,
    combinedScore: combinedScore(row),
    canEdit,
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
  species?: string[];
}): string {
  return [
    ...(input.species ?? []),
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
