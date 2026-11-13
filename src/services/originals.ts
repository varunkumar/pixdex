import type { SerializedPhoto } from '../types/api';

// Every original (local disk or Google Drive) goes through the same-origin /api/originals
// proxy (functions/api), which holds the tunnel token server-side and returns 502 when the
// machine hosting the originals is offline. The agent streams Drive files with its own token.
export function getOriginalUrl(photo: SerializedPhoto): string | null {
  if (photo.source === 'local' || photo.source === 'google_drive') {
    return `/api/originals/${encodeURIComponent(photo.id)}`;
  }
  return null;
}

/** A URL that serves the original as an image, usable for prefetching and a lightbox. */
export function getOriginalImageUrl(photo: SerializedPhoto): string | null {
  return getOriginalUrl(photo);
}

/** The Drive viewer page, only for Drive photos whose file id the caller may see (album owner). */
export function getDriveUrl(photo: SerializedPhoto): string | null {
  if (photo.source === 'google_drive' && photo.driveFileId) {
    return `https://drive.google.com/file/d/${photo.driveFileId}/view`;
  }
  return null;
}
