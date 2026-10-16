import { describe, expect, it } from 'vitest';
import { expandQuery, expandQueryTiers, type SynonymSets } from '../src/search/synonyms';

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

const sets: SynonymSets = {
  terms: dict,
  hard: [['tree', 'trees', 'branch', 'branches', 'bough']],
  soft: [['sleep', 'sleeping', 'sleeps', 'asleep', 'resting', 'napping']],
};

describe('plural and word-boundary handling', () => {
  it('treats "big cats" as the "big cat" category, with no leftover "cats" term', () => {
    const result = expandQuery('big cats', dict);
    expect(result).toContain('"leopard"');
    expect(result).not.toContain('"cats"');
    expect(result).not.toContain(' AND ');
  });

  it('does not match a category key inside a longer word', () => {
    expect(expandQuery('big catfish', dict)).toBe('"big" AND "catfish"');
  });

  it('matches a plural of a single-word key', () => {
    expect(expandQuery('raptors', dict)).toContain('"eagle"');
  });
});

describe('expandQueryTiers', () => {
  it('expands the example query into one group per concept', () => {
    const [strict] = expandQueryTiers('big cats sleeping on a tree', sets);
    expect(strict).toContain('"leopard"');
    expect(strict).toContain('"resting"');
    expect(strict).toContain('"branch"');
    expect(strict).not.toContain('"cats"');
    expect(strict.split(' AND ').length).toBe(3);
  });

  it('second tier drops action words and keeps the nouns', () => {
    const tiers = expandQueryTiers('big cats sleeping on a tree', sets);
    expect(tiers.length).toBe(3);
    expect(tiers[1]).not.toContain('"sleeping"');
    expect(tiers[1]).toContain('"leopard"');
    expect(tiers[1]).toContain('"tree"');
  });

  it('last tier matches any group', () => {
    const tiers = expandQueryTiers('red leopard', sets);
    expect(tiers[tiers.length - 1]).toBe('"red" OR "leopard"');
  });

  it('does not repeat identical tiers', () => {
    expect(expandQueryTiers('leopard', sets)).toEqual(['"leopard"']);
    expect(expandQueryTiers('red leopard', sets)).toEqual(['"red" AND "leopard"', '"red" OR "leopard"']);
  });

  it('returns no tiers for an empty query', () => {
    expect(expandQueryTiers('  ', sets)).toEqual([]);
  });

  it('quotes every term so user input cannot inject FTS syntax', () => {
    expect(expandQueryTiers('tiger" OR NOT', sets)[0]).toBe('"tiger" AND "not"');
    expect(expandQueryTiers('x*', sets)[0]).toBe('"x"');
  });
});
