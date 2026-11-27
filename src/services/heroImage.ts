// Album hero banners: a copy of the cover photo resized to a 2048px long side, made once by the album
// owner's browser from the original and stored in R2 behind /api/heroes/<content hash>.

const THUMBNAIL_PREFIX = '/thumbnails/';
const MAX_SIDE = 2048;
// The Worker refuses a larger upload.
const MAX_BYTES = 2 * 1024 * 1024;
const QUALITIES = [0.85, 0.75, 0.65, 0.5];

/** The cover photo's content hash, taken from its thumbnail URL. */
export function heroHash(coverThumbnailUrl: string | null | undefined): string | null {
  if (!coverThumbnailUrl?.startsWith(THUMBNAIL_PREFIX)) return null;
  return coverThumbnailUrl.slice(THUMBNAIL_PREFIX.length) || null;
}

/** The size with its long side at most `max`, keeping the shape. Never enlarges. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

function encodeJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

/**
 * An upright JPEG of the original with a long side of at most 2048px, at the best quality that fits in
 * 2 MB. Throws when the browser cannot decode or encode it, or no quality fits.
 */
export async function resizeToJpeg(original: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(original, { imageOrientation: 'from-image' });
  const canvas = document.createElement('canvas');
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, MAX_SIDE);
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is not available');
    // JPEG has no transparency: without a white ground, transparent pixels encode as black.
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
  } finally {
    // The decoded original is large; free it before encoding.
    bitmap.close();
  }
  for (const quality of QUALITIES) {
    const jpeg = await encodeJpeg(canvas, quality);
    if (jpeg && jpeg.size <= MAX_BYTES) return jpeg;
  }
  throw new Error('Could not encode the image within the size limit');
}

/**
 * The URL of the album hero, or null when there is none to show. A missing hero is created from the
 * original when `canCreate` (album owner). Never rejects: the caller keeps its placeholder on null.
 */
export async function loadHero(contentHash: string, photoId: string, canCreate: boolean): Promise<string | null> {
  const url = `/api/heroes/${contentHash}`;
  try {
    const existing = await fetch(url);
    if (existing.ok) {
      // Read the body so the browser cache serves the <img> that follows.
      await existing.blob();
      return url;
    }
    if (existing.status !== 404 || !canCreate) return null;

    const original = await fetch(`/api/originals/${encodeURIComponent(photoId)}`);
    if (!original.ok) return null;
    const body = await resizeToJpeg(await original.blob());
    const upload = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body });
    return upload.ok ? url : null;
  } catch {
    return null;
  }
}
