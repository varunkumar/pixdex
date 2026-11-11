import { describe, expect, it } from 'vitest';
import { personOptions } from '../peopleKeys';

describe('personOptions', () => {
  it('numbers several unnamed people by list order, display only', () => {
    expect(
      personOptions([
        { id: 'a', name: 'Mum' },
        { id: 'b', name: null },
        { id: 'c', name: null },
      ])
    ).toEqual([
      { value: 'a', label: 'Mum' },
      { value: 'b', label: 'Unnamed person 1' },
      { value: 'c', label: 'Unnamed person 2' },
    ]);
  });
  it('leaves a single unnamed person without a number', () => {
    expect(personOptions([{ id: 'b', name: null }])).toEqual([{ value: 'b', label: 'Unnamed person' }]);
  });
});
