import { describe, expect, it } from 'vitest';
import { clampFraming, DEFAULT_FRAMING, dragFraming, frameStyle } from '../framing';

const NATURAL = { w: 3000, h: 2000 };
const BOX = { w: 1200, h: 300 };

describe('DEFAULT_FRAMING', () => {
  it('is the centre at 1x', () => {
    expect(DEFAULT_FRAMING).toEqual({ x: 50, y: 50, zoom: 1 });
  });
});

describe('clampFraming', () => {
  it('keeps x and y within 0 to 100 and zoom within 1 to 3', () => {
    expect(clampFraming({ x: -3, y: 104, zoom: 0.4 })).toEqual({ x: 0, y: 100, zoom: 1 });
    expect(clampFraming({ x: 101, y: -1, zoom: 7 })).toEqual({ x: 100, y: 0, zoom: 3 });
  });

  it('rounds to two decimals, so repeated steps stay exact', () => {
    expect(clampFraming({ x: 33.33333, y: 66.66666, zoom: 1 + 0.1 + 0.1 })).toEqual({ x: 33.33, y: 66.67, zoom: 1.2 });
  });
});

describe('frameStyle', () => {
  it('positions, anchors and scales the image', () => {
    expect(frameStyle({ x: 20, y: 70, zoom: 1.5 })).toEqual({
      objectPosition: '20% 70%',
      transformOrigin: '20% 70%',
      transform: 'scale(1.5)',
    });
  });
});

describe('dragFraming', () => {
  it('moves the focal point against the drag, by the share of the overflow', () => {
    // Rendered 1200x800: 500px of vertical overflow, none sideways.
    expect(dragFraming(DEFAULT_FRAMING, 0, 50, NATURAL, BOX)).toEqual({ x: 50, y: 40, zoom: 1 });
  });

  it('counts the zoom in the overflow', () => {
    // At 2x: 2400 - 1200 = 1200px of horizontal overflow.
    expect(dragFraming({ x: 50, y: 50, zoom: 2 }, -120, 0, NATURAL, BOX)).toEqual({ x: 60, y: 50, zoom: 2 });
  });

  it('leaves an axis with under half a pixel of overflow unchanged', () => {
    expect(dragFraming(DEFAULT_FRAMING, 400, 0, NATURAL, BOX)).toEqual(DEFAULT_FRAMING);
    expect(dragFraming(DEFAULT_FRAMING, 5, 5, { w: 1200.4, h: 300 }, BOX)).toEqual(DEFAULT_FRAMING);
  });

  it('clamps to 0 and 100', () => {
    expect(dragFraming({ x: 50, y: 50, zoom: 2 }, 5000, 5000, NATURAL, BOX)).toEqual({ x: 0, y: 0, zoom: 2 });
    expect(dragFraming({ x: 50, y: 50, zoom: 2 }, -5000, -5000, NATURAL, BOX)).toEqual({ x: 100, y: 100, zoom: 2 });
  });

  it('does not move when a size is unknown', () => {
    expect(dragFraming(DEFAULT_FRAMING, 10, 10, { w: 0, h: 0 }, BOX)).toEqual(DEFAULT_FRAMING);
    expect(dragFraming(DEFAULT_FRAMING, 10, 10, NATURAL, { w: 0, h: 0 })).toEqual(DEFAULT_FRAMING);
  });
});
