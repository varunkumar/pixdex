import { describe, expect, it } from 'vitest';
import { expandQuery } from '../src/search/synonyms';

const dict = {
  'big cat': ['leopard', 'tiger', 'lion', 'jaguar', 'cheetah', 'panther'],
  raptor: ['eagle', 'hawk', 'osprey', 'falcon', 'kite'],
};

describe('expandQuery', () => {
  it('expands a recognized category term into an OR of its members', () => {
    const result = expandQuery('big cat', dict);
    expect(result).toContain('"leopard"');
    expect(result).toContain('"tiger"');
    expect(result).toContain('"big cat"');
    expect(result.split(' OR ').length).toBeGreaterThan(1);
  });

  it('passes an unrecognized term through unchanged, just quoted', () => {
    expect(expandQuery('elephant', dict)).toBe('"elephant"');
  });

  it('returns an empty string for an empty query', () => {
    expect(expandQuery('   ', dict)).toBe('');
  });
});
