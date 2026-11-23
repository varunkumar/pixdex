const FALLBACK_RATIO = 4 / 3;
const MIN_RATIO = 0.4;
const MAX_RATIO = 3;

/** Width over height for a tile, clamped; 4/3 when either side is missing, zero or not finite. */
export function photoRatio(photo: { width: number | null; height: number | null }): number {
  const { width, height } = photo;
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height)) return FALLBACK_RATIO;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, width / height));
}

/** Deals items (in order) into the currently shortest column; returns each column's item indexes. */
export function assignColumns(ratios: number[], columns: number): number[][] {
  const result: number[][] = Array.from({ length: columns }, () => []);
  const heights: number[] = new Array<number>(columns).fill(0);
  ratios.forEach((ratio, index) => {
    let shortest = 0;
    for (let c = 1; c < columns; c++) if (heights[c] < heights[shortest]) shortest = c;
    result[shortest].push(index);
    heights[shortest] += 1 / ratio;
  });
  return result;
}
