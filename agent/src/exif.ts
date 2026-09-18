import exifr from 'exifr';
import sharp from 'sharp';

export interface PhotoExifData {
  dateTime?: string;
  dimensions: { width: number; height: number };
  format?: string;
  size?: number;
  space?: string;
  hasAlpha?: boolean;
  channels?: number;
}

export async function extractExifData(filePath: string): Promise<PhotoExifData> {
  const metadata = await sharp(filePath).metadata();

  let dateTime: string | undefined;
  try {
    const parsed = await exifr.parse(filePath, ['DateTimeOriginal', 'CreateDate']);
    const raw = parsed?.DateTimeOriginal ?? parsed?.CreateDate;
    if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
      dateTime = raw.toISOString();
    }
  } catch {
    // No readable EXIF — dateTime stays undefined; caller may fall back to filesystem mtime.
  }

  return {
    dateTime,
    dimensions: { width: metadata.width ?? 0, height: metadata.height ?? 0 },
    format: metadata.format,
    size: metadata.size,
    space: metadata.space,
    hasAlpha: metadata.hasAlpha,
    channels: metadata.channels,
  };
}
