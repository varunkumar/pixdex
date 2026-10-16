// Naming faces changes what searches and listings return.
export const SEARCH_KEYS = [
  'search',
  'album-photos',
  'albums-page',
  'dailyPick',
  'recent-photos',
  'person-photos',
];

export function errorMessage(err: unknown, naming: boolean): string {
  const message = err instanceof Error ? err.message : '';
  if (message.includes('409')) return 'That name already exists';
  return naming ? 'Could not save the name' : 'Something went wrong, try again';
}
