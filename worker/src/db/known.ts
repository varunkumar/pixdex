// Filter by known personality (`known=Q1,Q2`): photos that contain a face matched to every listed
// known id. Shares one cap of MAX_FILTER_PEOPLE with the `people` filter. Ids are always bound.
export const MAX_FILTER_PEOPLE = 5;

/** Splits, trims and dedupes the ids, keeping at most MAX_FILTER_PEOPLE - taken (never negative). */
export function parseKnown(raw: string | undefined, taken: number): string[] {
  const room = Math.max(MAX_FILTER_PEOPLE - taken, 0);
  return [
    ...new Set(
      (raw ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    ),
  ].slice(0, room);
}

/** AND clause on photos.id; walks idx_faces_known_photo (known_id, photo_id). A face counts with or without a person. */
export function knownFilterSql(known: string[]): { sql: string; params: unknown[] } {
  if (known.length === 0) return { sql: '', params: [] };
  return {
    sql: ` AND photos.id IN (SELECT photo_id FROM faces WHERE known_id IN (${known.map(() => '?').join(',')}) GROUP BY photo_id HAVING COUNT(DISTINCT known_id) = ?)`,
    params: [...known, known.length],
  };
}
