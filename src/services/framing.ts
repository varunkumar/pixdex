// How an album cover sits in its banner: x and y are the focal point in percent, zoom is 1 to 3.
// Rendered with object-fit: cover plus frameStyle(), which never leaves a gap, whatever the banner's shape.
import type { CSSProperties } from 'react';

export type Framing = { x: number; y: number; zoom: number };
export type Size = { w: number; h: number };

export const DEFAULT_FRAMING: Framing = { x: 50, y: 50, zoom: 1 };
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 3;

// Under this many hidden pixels there is nothing to move, and dividing by them would jump.
const MIN_OVERFLOW = 0.5;

const clamp = (value: number, min: number, max: number) =>
  Math.round(Math.min(max, Math.max(min, value)) * 100) / 100;

/** Within the allowed ranges, to two decimals (so repeated steps do not pile up floating point noise). */
export function clampFraming({ x, y, zoom }: Framing): Framing {
  return { x: clamp(x, 0, 100), y: clamp(y, 0, 100), zoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM) };
}

export function frameStyle({ x, y, zoom }: Framing): CSSProperties {
  const point = `${x}% ${y}%`;
  return { objectPosition: point, transformOrigin: point, transform: `scale(${zoom})` };
}

/** The framing after dragging the picture by (dx, dy) pixels: it follows the pointer. */
export function dragFraming(start: Framing, dx: number, dy: number, natural: Size, box: Size): Framing {
  if (!(natural.w > 0 && natural.h > 0)) return start;
  const cover = Math.max(box.w / natural.w, box.h / natural.h);
  const moved = (percent: number, delta: number, size: number, frame: number) => {
    const overflow = size * cover * start.zoom - frame;
    return overflow < MIN_OVERFLOW ? percent : percent - (delta / overflow) * 100;
  };
  return clampFraming({
    x: moved(start.x, dx, natural.w, box.w),
    y: moved(start.y, dy, natural.h, box.h),
    zoom: start.zoom,
  });
}
