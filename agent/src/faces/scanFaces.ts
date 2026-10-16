import sharp from 'sharp';
import type { CloudflareClient } from '../cloudflareClient';
import type { FaceSidecarClient } from './sidecarClient';

const MAX_SIDE = 1280;

/** An upright (EXIF-rotated) JPEG with the longest side capped, as the sidecar expects. */
export async function prepareFaceImage(filePath: string): Promise<Buffer> {
  return sharp(filePath)
    .rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
}

/** The Worker has no row for this content hash (ingest/faces returned 404). */
export class PhotoNotIndexedError extends Error {
  constructor(contentHash: string) {
    super(`photo not indexed: ${contentHash}`);
  }
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** The Worker accepts at most this many faces per ingest request; keep the largest by area. */
export const MAX_FACES_PER_PHOTO = 10;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Maps a normalised point in the upright (EXIF-rotated) image back to the raw
 * sensor frame, which is what stored thumbnails use (they are not rotated).
 * 1 or undefined is the identity.
 */
function uprightToRaw(orientation: number | undefined, u: number, v: number): [number, number] {
  switch (orientation) {
    case 2:
      return [1 - u, v];
    case 3:
      return [1 - u, 1 - v];
    case 4:
      return [u, 1 - v];
    case 5:
      return [v, u];
    case 6:
      return [v, 1 - u];
    case 7:
      return [1 - v, 1 - u];
    case 8:
      return [1 - v, u];
    default:
      return [u, v];
  }
}

/** Maps a normalised upright-frame box into the raw frame (all 8 EXIF orientations). */
export function uprightBoxToRaw(box: Box, orientation: number | undefined): Box {
  const [ax, ay] = uprightToRaw(orientation, box.x, box.y);
  const [bx, by] = uprightToRaw(orientation, box.x + box.w, box.y + box.h);
  const x = Math.min(ax, bx);
  const y = Math.min(ay, by);
  return { x, y, w: Math.max(ax, bx) - x, h: Math.max(ay, by) - y };
}

/** Detects faces and stores them on the Worker; returns the face count. */
export async function scanFaces(
  filePath: string,
  contentHash: string,
  deps: { sidecar: FaceSidecarClient; cloudflareClient: CloudflareClient }
): Promise<number> {
  const { sidecar, cloudflareClient } = deps;
  const detection = await sidecar.detect(await prepareFaceImage(filePath));
  const { width, height } = detection;
  const { orientation } = await sharp(filePath).metadata();

  const all = detection.faces.map((face) => {
    const x1 = clamp01(face.bbox[0] / width);
    const y1 = clamp01(face.bbox[1] / height);
    const x2 = clamp01(face.bbox[2] / width);
    const y2 = clamp01(face.bbox[3] / height);
    return {
      bbox: uprightBoxToRaw({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, orientation),
      detScore: face.detScore,
      embedding: face.embedding,
    };
  });
  const faces = [...all]
    .sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h)
    .slice(0, MAX_FACES_PER_PHOTO);

  // An empty list is posted on purpose: it marks the photo as scanned with this model.
  if (!(await cloudflareClient.ingestFaces(contentHash, detection.model, faces))) {
    throw new PhotoNotIndexedError(contentHash);
  }
  return faces.length;
}
