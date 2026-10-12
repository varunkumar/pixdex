import fs from 'node:fs/promises';
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
  camera: CameraExif;
}

/** Standard camera details, each present only when the file carries it. */
export interface CameraExif {
  cameraMake?: string;
  cameraModel?: string;
  lensModel?: string;
  focalLength?: number;
  fNumber?: number;
  exposureTime?: number;
  iso?: number;
  latitude?: number;
  longitude?: number;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export async function extractCameraExif(filePath: string): Promise<CameraExif> {
  const camera: CameraExif = {};
  try {
    const tags = await exifr.parse(filePath, [
      'Make',
      'Model',
      'LensModel',
      'FocalLength',
      'FNumber',
      'ExposureTime',
      'ISO',
    ]);
    camera.cameraMake = text(tags?.Make);
    camera.cameraModel = text(tags?.Model);
    camera.lensModel = text(tags?.LensModel);
    camera.focalLength = num(tags?.FocalLength);
    camera.fNumber = num(tags?.FNumber);
    camera.exposureTime = num(tags?.ExposureTime);
    const iso = num(tags?.ISO);
    camera.iso = iso === undefined ? undefined : Math.round(iso);
  } catch {
    // No readable EXIF: leave the camera fields undefined.
  }
  try {
    const gps = await exifr.gps(filePath);
    camera.latitude = num(gps?.latitude);
    camera.longitude = num(gps?.longitude);
  } catch {
    // No GPS tags.
  }
  return camera;
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
    size: metadata.size ?? (await fs.stat(filePath)).size,
    space: metadata.space,
    hasAlpha: metadata.hasAlpha,
    channels: metadata.channels,
    camera: await extractCameraExif(filePath),
  };
}
