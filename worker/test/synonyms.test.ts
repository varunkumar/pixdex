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

  it('requires every meaningful word by default and drops field-hint filler', () => {
    expect(expandQuery('red leopard', dict)).toBe('"red" AND "leopard"');
    expect(expandQuery('red pattern', dict)).toBe('"red"');
    expect(expandQuery('red colors', dict)).toBe('"red"');
    expect(expandQuery('photos of the red kite', dict)).toBe('"red" AND "kite"');
  });

  it('keeps a multi-word synonym key as one group alongside other words', () => {
    const result = expandQuery('red big cat', dict);
    expect(result).toContain('("big cat" OR "leopard"');
    expect(result).toContain('"red"');
    expect(result).toContain(' AND ');
  });

  it('can loosen to any word', () => {
    expect(expandQuery('red leopard', dict, 'any')).toBe('"red" OR "leopard"');
  });

  it('falls back to the typed query when only filler words are given', () => {
    expect(expandQuery('colors', dict)).toBe('"colors"');
  });
});
