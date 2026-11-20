// Filter by species (`species=<scientific name>`): photos whose `species` JSON lists that scientific
// name. The name is always bound. Malformed or NULL JSON and non-object elements never match (the CASE guards keep SQLite from raising).
export const MAX_SPECIES_NAME = 200;

/** AND clause on photos.species; empty when the name is undefined, blank or longer than 200 characters. */
export function speciesFilterSql(scientific: string | undefined): { sql: string; params: unknown[] } {
  const name = (scientific ?? '').trim();
  if (!name || name.length > MAX_SPECIES_NAME) return { sql: '', params: [] };
  return {
    sql: ` AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(photos.species) THEN photos.species ELSE '[]' END) WHERE CASE WHEN type = 'object' THEN json_extract(value, '$.scientific') END = ?)`,
    params: [name],
  };
}
