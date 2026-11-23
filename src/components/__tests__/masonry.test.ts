import { describe, expect, it } from 'vitest';
import { assignColumns, photoRatio } from '../masonry';

describe('photoRatio', () => {
  it('falls back to 4/3 when a side is missing, zero or not finite', () => {
    expect(photoRatio({ width: null, height: 100 })).toBeCloseTo(4 / 3);
    expect(photoRatio({ width: 100, height: null })).toBeCloseTo(4 / 3);
    expect(photoRatio({ width: 0, height: 0 })).toBeCloseTo(4 / 3);
    expect(photoRatio({ width: Infinity, height: 10 })).toBeCloseTo(4 / 3);
  });

  it('is width over height, clamped to 0.4 .. 3', () => {
    expect(photoRatio({ width: 1600, height: 1067 })).toBeCloseTo(1600 / 1067);
    expect(photoRatio({ width: 100, height: 1000 })).toBe(0.4);
    expect(photoRatio({ width: 1000, height: 10 })).toBe(3);
  });
});

describe('assignColumns', () => {
  it('deals equal items round-robin, leftmost first on ties', () => {
    expect(assignColumns([1, 1, 1, 1], 2)).toEqual([
      [0, 2],
      [1, 3],
    ]);
  });

  it('puts the next item in the shortest column', () => {
    expect(assignColumns([0.5, 2, 2, 2], 2)).toEqual([[0], [1, 2, 3]]);
  });

  it('handles an empty list and fewer items than columns', () => {
    expect(assignColumns([], 3)).toEqual([[], [], []]);
    expect(assignColumns([1, 1], 4)).toEqual([[0], [1], [], []]);
  });

  it('places every index exactly once, in order within a column', () => {
    const ratios = Array.from({ length: 50 }, (_, i) => 0.4 + ((i * 37) % 26) / 10);
    const cols = assignColumns(ratios, 5);
    expect(cols.flat().sort((a, b) => a - b)).toEqual(ratios.map((_, i) => i));
    for (const col of cols) expect(col).toEqual([...col].sort((a, b) => a - b));
  });
});
