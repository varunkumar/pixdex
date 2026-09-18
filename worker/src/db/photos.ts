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
