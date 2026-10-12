import { describe, expect, it } from 'vitest';
import { shortDescription } from '../text';

describe('shortDescription', () => {
  it('returns short text unchanged and handles missing text', () => {
    expect(shortDescription('A tiger on a rock.')).toBe('A tiger on a rock.');
    expect(shortDescription(null)).toBe('');
    expect(shortDescription(undefined)).toBe('');
  });

  it('keeps the first sentence when the text is long', () => {
    const text =
      'A single adult Bengal tiger stands alert on a granite ledge. Its coat is marked by bold black stripes across the torso and legs, with a white underbelly and a long banded tail hanging down.';
    expect(shortDescription(text)).toBe('A single adult Bengal tiger stands alert on a granite ledge.');
  });

  it('cuts at a word boundary with an ellipsis when there is no short first sentence', () => {
    const text = 'word '.repeat(80).trim();
    const result = shortDescription(text, 50);
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result.endsWith('…')).toBe(true);
    expect(result).not.toMatch(/wor…$/);
  });
});
