// Filter by species (`species=<scientific name>`): photos whose `species` JSON lists that scientific
// name. The name is always bound. json_valid guards rows whose JSON is malformed or NULL (they never match).
export const MAX_SPECIES_NAME = 200;

/** AND clause on photos.species; empty when the name is undefined, blank or longer than 200 characters. */
export function speciesFilterSql(scientific: string | undefined): { sql: string; params: unknown[] } {
  const name = (scientific ?? '').trim();
  if (!name || name.length > MAX_SPECIES_NAME) return { sql: '', params: [] };
  return {
    sql: ` AND json_valid(photos.species) AND EXISTS (SELECT 1 FROM json_each(photos.species) WHERE json_extract(value, '$.scientific') = ?)`,
    params: [name],
  };
}
