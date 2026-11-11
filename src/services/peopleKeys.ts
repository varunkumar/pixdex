// Naming faces changes what searches and listings return.
export const SEARCH_KEYS = [
  'search',
  'album-photos',
  'albums-page',
  'dailyPick',
  'recent-photos',
  'person-photos',
  // Unassigned-face groups on the People page shrink as faces get named.
  'people-groups',
];

/** Shown for a person the caller has not named themselves (the owner's name is never sent to them). */
export const UNNAMED_PERSON = 'Unnamed person';

/**
 * Filter options for a list of people. Several unnamed people (a viewer with no labels) are told apart by list
 * order ("Unnamed person 1", "Unnamed person 2"); display only, the ids are unchanged.
 */
export function personOptions(people: { id: string; name: string | null }[]): { value: string; label: string }[] {
  const unnamed = people.filter((p) => p.name === null).length;
  let n = 0;
  return people.map((p) => ({
    value: p.id,
    label: p.name ?? (unnamed > 1 ? `${UNNAMED_PERSON} ${++n}` : UNNAMED_PERSON),
  }));
}

export function errorMessage(err: unknown, naming: boolean): string {
  const message = err instanceof Error ? err.message : '';
  if (message.includes('409')) return 'That name already exists';
  return naming ? 'Could not save the name' : 'Something went wrong, try again';
}

/** "Matched N more faces" (singular for 1). */
export const matchedMessage = (matched: number) => `Matched ${matched} more face${matched === 1 ? '' : 's'}`;

/** Shown when matchPersonAll hit its page cap before the Worker ran out of pages. */
export const TRUNCATED_MESSAGE = 'Stopped early, run Re-run matching to continue';
