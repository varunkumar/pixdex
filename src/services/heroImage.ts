// Album hero banners show the cover photo's original file, unmodified. Each browser keeps one copy per
// album (heroStore.ts), made from /api/originals by whoever opens the album page.
import { readHero, writeHero, type HeroRecord } from './heroStore';

const THUMBNAIL_PREFIX = '/thumbnails/';

/** The cover photo's content hash, taken from its thumbnail URL. */
export function heroHash(coverThumbnailUrl: string | null | undefined): string | null {
  if (!coverThumbnailUrl?.startsWith(THUMBNAIL_PREFIX)) return null;
  return coverThumbnailUrl.slice(THUMBNAIL_PREFIX.length) || null;
}

/** The original file as served, or null when it cannot be had now (offline, tunnel or agent down, no access). */
async function fetchOriginal(photoId: string): Promise<Blob | null> {
  try {
    const response = await fetch(`/api/originals/${encodeURIComponent(photoId)}`);
    // A sign-in or error page can arrive with status 200.
    const type = response.headers.get('Content-Type')?.toLowerCase();
    if (!response.ok || !type?.startsWith('image/')) return null;
    return await response.blob();
  } catch {
    return null;
  }
}

/** Whether this browser can show the image (HEIC, for one, only in some). */
async function canDecode(image: Blob): Promise<boolean> {
  const url = URL.createObjectURL(image);
  try {
    const element = new Image();
    element.src = url;
    await element.decode();
    return true;
  } catch {
    return false;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function load(album: string, contentHash: string, photoId: string): Promise<Blob | null> {
  const stored = await readHero(album);
  if (stored?.contentHash === contentHash) {
    if (stored.status === 'ready' && stored.image) return stored.image;
    if (stored.status === 'undecodable') return null;
  }

  const save = (status: HeroRecord['status'], image?: Blob) =>
    writeHero({ album, contentHash, status, ...(image && { image }), updatedAt: Date.now() });

  const original = await fetchOriginal(photoId);
  if (!original) {
    await save('unavailable');
    return null;
  }
  if (!(await canDecode(original))) {
    await save('undecodable');
    return null;
  }
  await save('ready', original);
  return original;
}

/** Attempts under way, so two mounts at once share one download. */
const inFlight = new Map<string, Promise<Blob | null>>();

/**
 * The album hero image, or null when there is none to show. Comes from the browser store when it holds this
 * cover, otherwise from the original, and the outcome is stored. Never rejects: the caller keeps its
 * placeholder on null.
 */
export function loadHero(album: string, contentHash: string, photoId: string): Promise<Blob | null> {
  const key = JSON.stringify([album, contentHash]);
  let attempt = inFlight.get(key);
  if (!attempt) {
    attempt = load(album, contentHash, photoId)
      .catch(() => null)
      .finally(() => inFlight.delete(key));
    inFlight.set(key, attempt);
  }
  return attempt;
}
