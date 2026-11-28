import { describe, expect, it } from 'vitest';
import { faceRows } from '../faceRows';

describe('faceRows', () => {
  it('fits as many 96px faces as it can, with the wide gap from 544px', () => {
    // 1200px holds 10 faces of at least 96px with 16px gaps.
    expect(faceRows(20, 1200)).toEqual({ gap: 16, rows: [10, 10] });
  });

  it('deals the faces evenly into rows instead of leaving a short last row', () => {
    expect(faceRows(24, 1200).rows).toEqual([8, 8, 8]);
    expect(faceRows(31, 1200).rows).toEqual([8, 8, 8, 7]);
    expect(faceRows(11, 1200).rows).toEqual([6, 5]);
  });

  it('keeps one row when the faces fit in it', () => {
    expect(faceRows(4, 1200).rows).toEqual([4]);
  });

  it('keeps three across on a narrow phone, with the small gap', () => {
    expect(faceRows(9, 288)).toEqual({ gap: 8, rows: [3, 3, 3] });
    expect(faceRows(4, 288).rows).toEqual([2, 2]);
  });

  it('has no rows without faces', () => {
    expect(faceRows(0, 1200).rows).toEqual([]);
  });
});
