import { describe, expect, it } from 'vitest';
import { MAX_PEOPLE_FILTER, parsePeopleSelection } from '../peopleSelection';

describe('parsePeopleSelection', () => {
  it('reads both lists, own people first', () => {
    expect(parsePeopleSelection('a1,b2', 'Q1')).toEqual({ people: ['a1', 'b2'], known: ['Q1'] });
  });

  it('dedupes people ids like known ids', () => {
    expect(parsePeopleSelection('a1,a1,b2', 'Q1,Q1')).toEqual({ people: ['a1', 'b2'], known: ['Q1'] });
  });

  it('dedupes before applying the cap', () => {
    expect(parsePeopleSelection('a,a,b,c,d,e', 'Q1').people).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(parsePeopleSelection('a,a,b,c,d,e', 'Q1').known).toEqual([]);
  });

  it('never exceeds the cap together', () => {
    const r = parsePeopleSelection('a,b,c', 'Q1,Q2,Q3');
    expect(r.people.length + r.known.length).toBe(MAX_PEOPLE_FILTER);
  });
});
