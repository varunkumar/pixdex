export type AlbumFilter = { kind: 'people' | 'known' | 'species'; value: string };

const first = (raw: string | null): string => (raw ?? '').split(',').find(Boolean) ?? '';

/**
 * The one active album filter from the URL. Precedence: people, then known, then species; the rest are dropped.
 * People and known use the first id only; a species value is one scientific name (taken whole).
 */
export function parseAlbumFilter(params: URLSearchParams): AlbumFilter | null {
  const people = first(params.get('people'));
  if (people) return { kind: 'people', value: people };
  const known = first(params.get('known'));
  if (known) return { kind: 'known', value: known };
  const species = (params.get('species') ?? '').trim();
  if (species) return { kind: 'species', value: species };
  return null;
}

/** A `useListParams().update` patch that sets the filter's param and clears the other two (null clears all). */
export function filterPatch(filter: AlbumFilter | null): Record<string, string | null> {
  return {
    people: filter?.kind === 'people' ? filter.value : null,
    known: filter?.kind === 'known' ? filter.value : null,
    species: filter?.kind === 'species' ? filter.value : null,
  };
}
