import type { SerializedPhoto } from '../types/api';

// Drive photos deep-link to Drive. Local-disk photos go through the same-origin
// /api/originals proxy (functions/api), which holds the tunnel token server-side
// and returns 502 when the machine hosting the originals is offline.
export function getOriginalUrl(photo: SerializedPhoto): string | null {
  if (photo.source === 'google_drive' && photo.driveFileId) {
    return `https://drive.google.com/file/d/${photo.driveFileId}/view`;
  }
  if (photo.source === 'local') {
    return `/api/originals/${encodeURIComponent(photo.id)}`;
  }
  return null;
}
