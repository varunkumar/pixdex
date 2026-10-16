import sharp from 'sharp';
import type { CloudflareClient, FacePayload } from '../cloudflareClient';
import type { FaceSidecarClient } from './sidecarClient';

const MAX_SIDE = 1280;
/** Longest side of the upright copy that face crops are cut from (sharper than the 1280 px detection copy). */
const CROP_SOURCE_SIDE = 2560;
const CROP_SIZE = 192;
const CROP_PADDING = 1.6;

/** An upright (EXIF-rotated) JPEG with the longest side capped, as the sidecar expects. */
export async function prepareFaceImage(filePath: string): Promise<Buffer> {
  return sharp(filePath)
    .rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
}

/**
 * A padded square JPEG of one face, cut from an upright copy of the original.
 * `box` is normalised in the upright frame; the square is clamped inside the image.
 */
export async function cropFace(upright: Buffer, box: Box): Promise<Buffer> {
  const { width = 0, height = 0 } = await sharp(upright).metadata();
  const side = Math.max(1, Math.round(Math.min(Math.min(width, height), Math.max(box.w * width, box.h * height) * CROP_PADDING)));
  const cx = (box.x + box.w / 2) * width;
  const cy = (box.y + box.h / 2) * height;
  const left = Math.round(Math.min(Math.max(0, cx - side / 2), width - side));
  const top = Math.round(Math.min(Math.max(0, cy - side / 2), height - side));
  return sharp(upright)
    .extract({ left, top, width: side, height: side })
    .resize(CROP_SIZE, CROP_SIZE, { withoutEnlargement: true })
    .jpeg({ quality: 85 })
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
    const upright = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    return {
      upright,
      bbox: uprightBoxToRaw(upright, orientation),
      detScore: face.detScore,
      embedding: face.embedding,
    };
  });
  const largest = [...all]
    .sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h)
    .slice(0, MAX_FACES_PER_PHOTO);

  // Only the kept faces get a crop, all cut from one upright copy of the original.
  let source: Buffer | undefined;
  const faces: FacePayload[] = [];
  for (const { upright, ...face } of largest) {
    let crop: string | undefined;
    try {
      source ??= await sharp(filePath)
        .rotate()
        .resize({ width: CROP_SOURCE_SIDE, height: CROP_SOURCE_SIDE, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 95 })
        .toBuffer();
      crop = (await cropFace(source, upright)).toString('base64');
    } catch {
      // A face without a crop still works: the UI falls back to the thumbnail.
    }
    faces.push(crop ? { ...face, crop } : face);
  }

  // An empty list is posted on purpose: it marks the photo as scanned with this model.
  if (!(await cloudflareClient.ingestFaces(contentHash, detection.model, faces))) {
    throw new PhotoNotIndexedError(contentHash);
  }
  return faces.length;
}
