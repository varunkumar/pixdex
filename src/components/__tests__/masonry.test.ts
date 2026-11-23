import { describe, expect, it } from 'vitest';
import { assignColumns, balanceColumns, columnGrow, photoRatio } from '../masonry';

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

const heights = (cols: number[][], ratios: number[]) => cols.map((c) => c.reduce((sum, i) => sum + 1 / ratios[i], 0));
const spread = (h: number[]) => Math.max(...h) - Math.min(...h);

describe('balanceColumns', () => {
  // Heights 5, 4, 3, 3, 3: greedy gives 8 and 10, the best split is 9 and 9.
  const ratios = [1 / 5, 1 / 4, 1 / 3, 1 / 3, 1 / 3];

  it('evens out column heights where the greedy deal leaves a gap', () => {
    expect(spread(heights(assignColumns(ratios, 2), ratios))).toBeCloseTo(2);
    expect(spread(heights(balanceColumns(ratios, 2), ratios))).toBeCloseTo(0);
  });

  it('never makes the spread worse and places every index exactly once, in order within a column', () => {
    const many = Array.from({ length: 40 }, (_, i) => 0.4 + ((i * 37) % 26) / 10);
    const greedy = spread(heights(assignColumns(many, 5), many));
    const balanced = balanceColumns(many, 5);
    expect(spread(heights(balanced, many))).toBeLessThanOrEqual(greedy + 1e-9);
    expect(balanced.flat().sort((a, b) => a - b)).toEqual(many.map((_, i) => i));
    for (const col of balanced) expect(col).toEqual([...col].sort((a, b) => a - b));
  });

  it('handles an empty list and fewer items than columns', () => {
    expect(balanceColumns([], 3)).toEqual([[], [], []]);
    expect(balanceColumns([1, 1], 4).flat().sort()).toEqual([0, 1]);
  });
});

describe('columnGrow', () => {
  it('gives a shorter column proportionally more width so every column ends at the same height', () => {
    // Heights 2 and 1 (no gaps): the short column gets twice the width, so both end at height 2 x 1 = 1 x 2.
    expect(columnGrow([[0, 1], [2]], [1, 1, 1], 0)).toEqual([0.5, 1]);
  });

  it('counts the gaps between tiles as part of a column height', () => {
    const [a, b] = columnGrow([[0, 1], [2]], [1, 1, 1], 0.1);
    expect(a).toBeCloseTo(1 / 2.1);
    expect(b).toBeCloseTo(1);
  });

  it('gives an empty column no width', () => {
    expect(columnGrow([[0], []], [1], 0)).toEqual([1, 0]);
  });
});
