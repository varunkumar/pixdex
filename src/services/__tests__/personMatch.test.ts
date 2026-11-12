import { describe, expect, it } from 'vitest';
import { matchesQuery, normalizeName } from '../personMatch';

describe('normalizeName', () => {
  it('strips accents, lowercases, turns .-_\' into spaces and collapses', () => {
    expect(normalizeName('  Beyoncé ')).toBe('beyonce');
    expect(normalizeName('A. R. Rahman')).toBe('a r rahman');
    expect(normalizeName("O'Brien-Smith_Jr")).toBe('o brien smith jr');
  });
});

describe('matchesQuery', () => {
  it('matches word prefixes', () => {
    expect(matchesQuery('dho', ['MS Dhoni'])).toBe(true);
    expect(matchesQuery('virat k', ['Virat Kohli'])).toBe(true);
    expect(matchesQuery('kohli virat', ['Virat Kohli'])).toBe(true);
  });
  it('matches initials written with or without dots and spaces', () => {
    expect(matchesQuery('ar rahman', ['A. R. Rahman'])).toBe(true);
    expect(matchesQuery('a r rahman', ['A. R. Rahman'])).toBe(true);
    expect(matchesQuery('rahman', ['A. R. Rahman'])).toBe(true);
  });
  it('matches any of the names or aliases', () => {
    expect(matchesQuery('msd', ['MS Dhoni', 'MSD'])).toBe(true);
  });
  it('is accent and case insensitive', () => {
    expect(matchesQuery('beyonce', ['Beyoncé'])).toBe(true);
    expect(matchesQuery('BEYO', ['beyoncé'])).toBe(true);
  });
  it('does not match unrelated, infix or fuzzy queries', () => {
    expect(matchesQuery('xyz', ['MS Dhoni'])).toBe(false);
    expect(matchesQuery('hon', ['MS Dhoni'])).toBe(false);
    expect(matchesQuery('dhoin', ['MS Dhoni'])).toBe(false);
    expect(matchesQuery('virat dhoni', ['Virat Kohli'])).toBe(false);
  });
  it('lists everything only for an empty or blank query', () => {
    expect(matchesQuery('', ['MS Dhoni'])).toBe(true);
    expect(matchesQuery('   ', ['MS Dhoni'])).toBe(true);
  });
  it('never matches everything for punctuation-only or too-short queries', () => {
    for (const q of ['.', '..', '-', "'", 'ms', 'a b']) expect(matchesQuery(q, ['MS Dhoni'])).toBe(false);
    expect(matchesQuery('ms', ['MS Dhoni'], 2)).toBe(true);
    expect(matchesQuery('.', ['MS Dhoni'], 1)).toBe(false);
    expect(matchesQuery(' - ', ['MS Dhoni'], 1)).toBe(false);
    expect(matchesQuery('m', ['MS Dhoni'], 1)).toBe(true);
  });
});
