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

/** Detects faces and stores them on the Worker; returns the face count. */
export async function scanFaces(
  filePath: string,
  contentHash: string,
  deps: { sidecar: FaceSidecarClient; cloudflareClient: CloudflareClient }
): Promise<number> {
  const { sidecar, cloudflareClient } = deps;
  const detection = await sidecar.detect(await prepareFaceImage(filePath));
  const { width, height } = detection;

  const faces = detection.faces.map((face) => {
    const x1 = clamp01(face.bbox[0] / width);
    const y1 = clamp01(face.bbox[1] / height);
    const x2 = clamp01(face.bbox[2] / width);
    const y2 = clamp01(face.bbox[3] / height);
    return {
      bbox: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 },
      detScore: face.detScore,
      embedding: face.embedding,
    };
  });

  // An empty list is posted on purpose: it marks the photo as scanned with this model.
  if (!(await cloudflareClient.ingestFaces(contentHash, detection.model, faces))) {
    throw new PhotoNotIndexedError(contentHash);
  }
  return faces.length;
}
