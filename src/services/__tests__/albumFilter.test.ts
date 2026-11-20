import { describe, expect, it } from 'vitest';
import { filterPatch, parseAlbumFilter } from '../albumFilter';

const p = (s: string) => new URLSearchParams(s);

describe('parseAlbumFilter', () => {
  it('prefers people, then known, then species', () => {
    expect(parseAlbumFilter(p('people=a&known=Q1&species=x'))).toEqual({ kind: 'people', value: 'a' });
    expect(parseAlbumFilter(p('known=Q1&species=x'))).toEqual({ kind: 'known', value: 'Q1' });
  });
  it('uses the first id only', () => {
    expect(parseAlbumFilter(p('known=Q1,Q2'))).toEqual({ kind: 'known', value: 'Q1' });
    expect(parseAlbumFilter(p('people=a,b'))).toEqual({ kind: 'people', value: 'a' });
  });
  it('round-trips a species name', () => {
    const patch = filterPatch({ kind: 'species', value: 'Elephas maximus' });
    const q = new URLSearchParams(Object.entries(patch).filter((e): e is [string, string] => e[1] !== null));
    expect(parseAlbumFilter(q)).toEqual({ kind: 'species', value: 'Elephas maximus' });
    expect(parseAlbumFilter(p('species=Elephas%20maximus'))?.value).toBe('Elephas maximus');
  });
  it('returns null without a filter', () => {
    expect(parseAlbumFilter(p(''))).toBeNull();
    expect(parseAlbumFilter(p('people=&known=,'))).toBeNull();
  });
});

describe('filterPatch', () => {
  it('sets one param and clears the other two', () => {
    expect(filterPatch({ kind: 'known', value: 'Q1' })).toEqual({ people: null, known: 'Q1', species: null });
  });
  it('clears all for null', () => {
    expect(filterPatch(null)).toEqual({ people: null, known: null, species: null });
  });
});
