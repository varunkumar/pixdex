export const EDGE_BUSY = 25;

export type Side = 'top' | 'bottom' | 'left' | 'right';

export interface TextSpace {
  side: Side;
  score: number;
}

const SAMPLE_SIZE = 48;
const FAILED: TextSpace = { side: 'top', score: 0 };

/**
 * Finds the calmest edge band of a square luma image. A pixel is calm when its
 * gradient |L(x+1,y)-L(x-1,y)| + |L(x,y+1)-L(x,y-1)| is below EDGE_BUSY; the
 * score of a side is the calm fraction of its band (width 40 percent of size).
 * Ties keep the first side in top, bottom, left, right order.
 */
export function textSpaceFromLuma(luma: ArrayLike<number>, size: number): TextSpace {
  const band = Math.round(size * 0.4);
  const calm = new Float64Array(size * size);
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const gx = Math.abs(luma[y * size + x + 1] - luma[y * size + x - 1]);
      const gy = Math.abs(luma[(y + 1) * size + x] - luma[(y - 1) * size + x]);
      calm[y * size + x] = gx + gy < EDGE_BUSY ? 1 : 0;
    }
  }

  const bandScore = (x0: number, x1: number, y0: number, y1: number): number => {
    let sum = 0;
    let count = 0;
    for (let y = Math.max(y0, 1); y < Math.min(y1, size - 1); y++) {
      for (let x = Math.max(x0, 1); x < Math.min(x1, size - 1); x++) {
        sum += calm[y * size + x];
        count++;
      }
    }
    return count === 0 ? 0 : sum / count;
  };

  const candidates: TextSpace[] = [
    { side: 'top', score: bandScore(0, size, 0, band) },
    { side: 'bottom', score: bandScore(0, size, size - band, size) },
    { side: 'left', score: bandScore(0, band, 0, size) },
    { side: 'right', score: bandScore(size - band, size, 0, size) },
  ];
  return candidates.reduce((best, c) => (c.score > best.score ? c : best));
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('thumbnail failed to load'));
    img.src = url;
  });
}

const cache = new Map<string, TextSpace>();

/** Measures a thumbnail's empty space. Failures resolve to score 0 and are not cached. */
export async function measureTextSpace(url: string): Promise<TextSpace> {
  const hit = cache.get(url);
  if (hit) return hit;
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE_SIZE;
    canvas.height = SAMPLE_SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return FAILED;
    ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    const { data } = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    const luma = new Float64Array(SAMPLE_SIZE * SAMPLE_SIZE);
    for (let i = 0; i < luma.length; i++) {
      luma[i] = 0.3 * data[i * 4] + 0.59 * data[i * 4 + 1] + 0.11 * data[i * 4 + 2];
    }
    const result = textSpaceFromLuma(luma, SAMPLE_SIZE);
    cache.set(url, result);
    return result;
  } catch {
    return FAILED;
  }
}
