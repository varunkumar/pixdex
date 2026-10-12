import type { SerializedPhoto } from '../types/api';

type ExifPhoto = Pick<
  SerializedPhoto,
  'cameraModel' | 'lensModel' | 'focalLength' | 'fNumber' | 'exposureTime' | 'iso'
>;

function formatShutter(seconds: number): string {
  if (seconds >= 1) return `${Number(seconds.toFixed(1))}s`;
  return `1/${Math.round(1 / seconds)}s`;
}

/** Camera body, lens and exposure settings as short display strings, skipping what is missing. */
export function exifSummary(photo: ExifPhoto): string[] {
  const parts: (string | null)[] = [
    photo.cameraModel ?? null,
    photo.lensModel ?? null,
    photo.focalLength != null ? `${Math.round(photo.focalLength)}mm` : null,
    photo.fNumber != null ? `f/${Number(photo.fNumber.toFixed(1))}` : null,
    photo.exposureTime != null && photo.exposureTime > 0 ? formatShutter(photo.exposureTime) : null,
    photo.iso != null ? `ISO ${photo.iso}` : null,
  ];
  return parts.filter((part): part is string => part !== null);
}

export function formatPhotoDate(dateTime: string | null | undefined): string | null {
  if (!dateTime) return null;
  const date = new Date(dateTime);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function mapsUrl(photo: Pick<SerializedPhoto, 'latitude' | 'longitude'>): string | null {
  if (photo.latitude == null || photo.longitude == null) return null;
  return `https://www.google.com/maps?q=${photo.latitude},${photo.longitude}`;
}
