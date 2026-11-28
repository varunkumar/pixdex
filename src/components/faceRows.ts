/** The smallest face tile, in pixels (the "Review auto matches" size). */
const FACE_SIZE = 96;
/** A narrow phone still shows three across, a little under FACE_SIZE. */
const MIN_PER_ROW = 3;
/** From this grid width the gap is wide (34rem). */
const WIDE_GRID = 544;

/**
 * The face count of each row for a grid of `width` pixels. It uses the fewest rows that keep faces at FACE_SIZE or
 * more, then deals the faces evenly: row counts differ by one at most. Each row then stretches to the full width.
 */
export function faceRows(count: number, width: number): { gap: number; rows: number[] } {
  const gap = width < WIDE_GRID ? 8 : 16;
  const perRow = Math.max(MIN_PER_ROW, Math.floor((width + gap) / (FACE_SIZE + gap)));
  const total = Math.ceil(count / perRow);
  const rows = Array.from({ length: total }, (_, i) => Math.floor(count / total) + (i < count % total ? 1 : 0));
  return { gap, rows };
}
