import type { SerializedPhoto } from '../types/api';

export interface OriginalsConfig {
  baseUrl: string;
  token: string;
}

export function getOriginalUrl(photo: SerializedPhoto, config: OriginalsConfig): string | null {
  if (photo.source === 'google_drive' && photo.driveFileId) {
    return `https://drive.google.com/file/d/${photo.driveFileId}/view`;
  }
  if (photo.source === 'local' && config.baseUrl && config.token) {
    return `${config.baseUrl}/originals/${photo.id}?token=${encodeURIComponent(config.token)}`;
  }
  return null;
}

export const originalsConfig: OriginalsConfig = {
  baseUrl: import.meta.env.VITE_ORIGINALS_BASE_URL ?? '',
  token: import.meta.env.VITE_ORIGINALS_TOKEN ?? '',
};
