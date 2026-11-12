import { describe, expect, it } from 'vitest';
import { knownFilterSql, parseKnown } from '../src/db/known';

describe('parseKnown', () => {
  it('splits, trims, dedupes and ignores empties', () => {
    expect(parseKnown(' Q1, Q2 ,,Q1', 0)).toEqual(['Q1', 'Q2']);
    expect(parseKnown(undefined, 0)).toEqual([]);
  });
  it('caps at 5 minus the people already taken', () => {
    expect(parseKnown('Q1,Q2,Q3,Q4,Q5,Q6', 0)).toHaveLength(5);
    expect(parseKnown('Q1,Q2,Q3,Q4,Q5,Q6', 2)).toEqual(['Q1', 'Q2', 'Q3']);
    expect(parseKnown('Q1', 5)).toEqual([]);
    expect(parseKnown('Q1', 9)).toEqual([]);
  });
});

describe('knownFilterSql', () => {
  it('is empty without ids and binds every id plus the count', () => {
    expect(knownFilterSql([])).toEqual({ sql: '', params: [] });
    const f = knownFilterSql(['Q1', 'Q2']);
    expect(f.params).toEqual(['Q1', 'Q2', 2]);
    expect(f.sql).toContain('known_id IN (?,?)');
    expect(f.sql).not.toContain('Q1');
  });
});
