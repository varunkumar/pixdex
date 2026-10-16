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

export function errorMessage(err: unknown, naming: boolean): string {
  const message = err instanceof Error ? err.message : '';
  if (message.includes('409')) return 'That name already exists';
  return naming ? 'Could not save the name' : 'Something went wrong, try again';
}

/** "Matched N more faces" (singular for 1). */
export const matchedMessage = (matched: number) => `Matched ${matched} more face${matched === 1 ? '' : 's'}`;

/** Shown when matchPersonAll hit its page cap before the Worker ran out of pages. */
export const TRUNCATED_MESSAGE = 'Stopped early, run Re-run matching to continue';
