/** Most people (own and known together) one search or timeline may filter by; the Worker enforces the same cap. */
export const MAX_PEOPLE_FILTER = 5;

const list = (raw: string | null): string[] => (raw ?? '').split(',').filter(Boolean);

/**
 * The People filter selection from the `people` and `known` URL params. Own people come first, known ids are
 * deduped and cut so both lists together never exceed the cap. Old URLs with only `people` parse as before.
 */
export function parsePeopleSelection(
  peopleParam: string | null,
  knownParam: string | null
): { people: string[]; known: string[] } {
  const people = list(peopleParam).slice(0, MAX_PEOPLE_FILTER);
  const known = [...new Set(list(knownParam))].slice(0, MAX_PEOPLE_FILTER - people.length);
  return { people, known };
}
