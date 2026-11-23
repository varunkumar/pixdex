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

const columnHeights = (columns: number[][], ratios: number[]): number[] =>
  columns.map((column) => column.reduce((sum, index) => sum + 1 / ratios[index], 0));

/**
 * The greedy deal, then moves and swaps between any two columns while they lower the spread of the column heights
 * (sum of squares). Similar heights keep the column widths of `columnGrow` close to each other. Keeps the reading
 * order roughly, at the price of a few photos swapping places.
 */
export function balanceColumns(ratios: number[], columns: number): number[][] {
  const result = assignColumns(ratios, columns).map((column) => [...column]);
  if (columns < 2) return result;
  const height = (index: number) => 1 / ratios[index];
  for (let round = 0; round < 200; round++) {
    const heights = columnHeights(result, ratios);
    let bestGain = 1e-9;
    let best: { a: number; b: number; x: number; y: number | null } | null = null;
    for (let a = 0; a < columns; a++) {
      for (let b = 0; b < columns; b++) {
        if (a === b) continue;
        for (const x of result[a]) {
          // Move x from column a to column b.
          const moved = heights[a] ** 2 + heights[b] ** 2 - (heights[a] - height(x)) ** 2 - (heights[b] + height(x)) ** 2;
          if (moved > bestGain) {
            bestGain = moved;
            best = { a, b, x, y: null };
          }
          for (const y of result[b]) {
            // Swap x (column a) with y (column b).
            const delta = height(x) - height(y);
            const swapped = heights[a] ** 2 + heights[b] ** 2 - (heights[a] - delta) ** 2 - (heights[b] + delta) ** 2;
            if (swapped > bestGain) {
              bestGain = swapped;
              best = { a, b, x, y };
            }
          }
        }
      }
    }
    if (!best) break;
    const { a, b, x, y } = best;
    result[a] = result[a].filter((i) => i !== x);
    result[b].push(x);
    if (y !== null) {
      result[b] = result[b].filter((i) => i !== y);
      result[a].push(y);
    }
    result[a].sort((p, q) => p - q);
    result[b].sort((p, q) => p - q);
  }
  return result;
}

/**
 * Relative width (a flex-grow value) for each column so that every column ends at the same height: a column's height
 * is its width times the sum of its tiles' 1 / ratio, so width is proportional to 1 / that sum. Tiles keep their
 * exact shape (no cropping); `gap` is the space between tiles in units of a column width. An empty column gets 0.
 */
export function columnGrow(columns: number[][], ratios: number[], gap = 0.025): number[] {
  return columns.map((column) => {
    if (column.length === 0) return 0;
    const height = column.reduce((sum, index) => sum + 1 / ratios[index], 0) + (column.length - 1) * gap;
    return 1 / height;
  });
}

const FLUSH_MIN = 0.6;
const FLUSH_MAX = 1.6;
const SPARSE_MIN = 0.8;
const SPARSE_MAX = 1.25;

/**
 * How wide each (non-empty) column should be, as a multiple of a normal column, and whether the grid can end flush.
 * Flush needs each column's width proportional to 1 / its height; that only looks right while the widths stay
 * moderate, and only when the page has enough photos to fill every column. Otherwise the grid does NOT stretch or
 * crop tiles to hide the gap: a short page keeps about one normal column per photo, and extreme widths fall back to
 * equal columns. A tile is never stretched or upscaled to chase a flush edge.
 */
export function planWidths(
  columns: number[][],
  ratios: number[],
  totalColumns: number,
  gap = 0.025
): { flush: boolean; widths: number[] } {
  const grow = columnGrow(columns, ratios, gap);
  const mean = grow.reduce((sum, g) => sum + g, 0) / Math.max(1, grow.length);
  const relative = grow.map((g) => (mean > 0 ? g / mean : 1));
  if (columns.length < totalColumns) {
    return { flush: false, widths: relative.map((w) => Math.min(SPARSE_MAX, Math.max(SPARSE_MIN, w))) };
  }
  if (relative.some((w) => w < FLUSH_MIN || w > FLUSH_MAX)) {
    return { flush: false, widths: relative.map(() => 1) };
  }
  return { flush: true, widths: relative };
}
