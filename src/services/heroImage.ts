// Album hero banners show the cover photo's original file, unmodified. Each browser keeps one copy per
// album (heroStore.ts), made from /api/originals by whoever opens the album page.
import { readHero, writeHero, type HeroRecord } from './heroStore';

const THUMBNAIL_PREFIX = '/thumbnails/';
// A download may take any time, as long as it never goes this long without a byte.
const IDLE_TIMEOUT_MS = 30_000;

/** The cover photo's content hash, taken from its thumbnail URL. */
export function heroHash(coverThumbnailUrl: string | null | undefined): string | null {
  if (!coverThumbnailUrl?.startsWith(THUMBNAIL_PREFIX)) return null;
  return coverThumbnailUrl.slice(THUMBNAIL_PREFIX.length) || null;
}

/**
 * The original file as served, or null when it cannot be had now (offline, tunnel or agent down, no access,
 * or a stalled request).
 */
async function fetchOriginal(photoId: string): Promise<Blob | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const restartTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
  };
  try {
    restartTimer();
    // Past the HTTP cache: a 200 that is not the image would otherwise be served again to every retry.
    const response = await fetch(`/api/originals/${encodeURIComponent(photoId)}`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    // A sign-in or error page can arrive with status 200.
    const type = response.headers.get('Content-Type');
    if (!response.ok || !type?.toLowerCase().startsWith('image/')) {
      // Stops the download. Not waited for, and a failure to cancel changes nothing.
      void response.body?.cancel().catch(() => {});
      return null;
    }
    if (!response.body) return null;
    // Read in chunks, to know the download is still moving.
    const reader = response.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    for (;;) {
      restartTimer();
      const { done, value } = await reader.read();
      if (done) return new Blob(chunks, { type });
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
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
