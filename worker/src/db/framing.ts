// How an album's cover sits in the banner, stored in albums.cover_framing as JSON {hash, x, y, zoom}:
// x and y are the focal point in percent, zoom is 1 to 3. NULL means the centre at 1x. It applies only
// while `hash` is the content hash of the album's current cover.
export const MAX_ZOOM = 3;

export interface Framing {
  x: number;
  y: number;
  zoom: number;
}

const inRange = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && v >= min && v <= max;

/** The stored framing for this cover, or null: none stored, another cover's, or not a valid value. */
export function parseFraming(raw: string | null, contentHash: string | null): Framing | null {
  if (!raw || !contentHash) return null;
  try {
    const v = JSON.parse(raw);
    if (v?.hash !== contentHash) return null;
    const { x, y, zoom } = v;
    return inRange(x, 0, 100) && inRange(y, 0, 100) && inRange(zoom, 1, MAX_ZOOM) ? { x, y, zoom } : null;
  } catch {
    return null;
  }
}
