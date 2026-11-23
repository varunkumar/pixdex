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
 * The greedy deal, then a few moves and swaps between the tallest and the shortest column while that lowers the taller
 * of the two. Keeps the bottom edge of the grid even, at the price of a slightly looser reading order.
 */
export function balanceColumns(ratios: number[], columns: number): number[][] {
  const result = assignColumns(ratios, columns).map((column) => [...column]);
  if (columns < 2) return result;
  const height = (index: number) => 1 / ratios[index];
  for (let round = 0; round < 100; round++) {
    const heights = columnHeights(result, ratios);
    const tall = heights.indexOf(Math.max(...heights));
    const short = heights.indexOf(Math.min(...heights));
    if (tall === short) break;
    const gap = heights[tall] - heights[short];
    // Best candidate: the one that leaves the taller of the two columns lowest.
    let bestMax = heights[tall] - 1e-9;
    let best: { from: number; to: number | null } | null = null;
    for (const a of result[tall]) {
      // Move a to the short column.
      const moved = Math.max(heights[tall] - height(a), heights[short] + height(a));
      if (moved < bestMax) {
        bestMax = moved;
        best = { from: a, to: null };
      }
      for (const b of result[short]) {
        // Swap a and b.
        const delta = height(a) - height(b);
        if (delta <= 0 || delta >= gap) continue;
        const swapped = Math.max(heights[tall] - delta, heights[short] + delta);
        if (swapped < bestMax) {
          bestMax = swapped;
          best = { from: a, to: b };
        }
      }
    }
    if (!best) break;
    result[tall] = result[tall].filter((i) => i !== best.from);
    if (best.to === null) result[short].push(best.from);
    else {
      result[short] = result[short].filter((i) => i !== best.to);
      result[short].push(best.from);
      result[tall].push(best.to);
    }
    result[tall].sort((x, y) => x - y);
    result[short].sort((x, y) => x - y);
  }
  return result;
}

/**
 * Per column: may its tiles grow a little (cropping the photos) so its bottom lines up with the tallest column?
 * Only when the gap is at most `maxExtra` of the column's own height, so a crop stays small; an empty column never.
 */
export function stretchColumns(columns: number[][], ratios: number[], maxExtra = 0.15): boolean[] {
  const heights = columnHeights(columns, ratios);
  const tallest = Math.max(0, ...heights);
  return heights.map((h) => h > 0 && (tallest - h) / h <= maxExtra);
}
