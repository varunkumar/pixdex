export const EDGE_BUSY = 25;

export type Side = 'top' | 'bottom' | 'left' | 'right';

export interface TextSpace {
  side: Side;
  score: number;
}

const SAMPLE_SIZE = 48;
const FAILED: TextSpace = { side: 'top', score: 0 };

/**
 * Finds the calmest edge band of a square luma image. The gradient
 * |L(x+1,y)-L(x-1,y)| + |L(x,y+1)-L(x,y-1)| is taken on interior pixels; each
 * band (width round(size * 0.4)) is valued by its mean gradient, the lowest
 * mean wins and score = max(0, 1 - mean / EDGE_BUSY). Ties keep the first side
 * in top, bottom, left, right order.
 */
export function textSpaceFromLuma(luma: ArrayLike<number>, size: number): TextSpace {
  const k = Math.round(size * 0.4);
  const g = new Float64Array(size * size);
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      g[y * size + x] =
        Math.abs(luma[y * size + x + 1] - luma[y * size + x - 1]) +
        Math.abs(luma[(y + 1) * size + x] - luma[(y - 1) * size + x]);
    }
  }

  const bandMean = (x0: number, x1: number, y0: number, y1: number): number => {
    let sum = 0;
    let count = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        sum += g[y * size + x];
        count++;
      }
    }
    return count === 0 ? Infinity : sum / count;
  };

  const last = size - 2;
  const bands: { side: Side; mean: number }[] = [
    { side: 'top', mean: bandMean(1, last, 1, k - 1) },
    { side: 'bottom', mean: bandMean(1, last, size - k, last) },
    { side: 'left', mean: bandMean(1, k - 1, 1, last) },
    { side: 'right', mean: bandMean(size - k, last, 1, last) },
  ];
  const best = bands.reduce((b, c) => (c.mean < b.mean ? c : b));
  return { side: best.side, score: Math.max(0, 1 - best.mean / EDGE_BUSY) };
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
