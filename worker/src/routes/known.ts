import type { Context } from 'hono';
import type { Env } from '../types';
import { userOf } from '../access';
import { scopeFor } from '../db/visibility';

/** CROSS JOIN pins faces as the outer table: without it the planner scans photos and probes faces by photo_id. Grouped aggregate of known-person matches; append a scopeFor(user, 'p.album') clause and GROUP BY. Exported for the query-plan test. */
export const KNOWN_COUNTS_SQL = `SELECT f.known_id AS id, COUNT(DISTINCT f.photo_id) AS photo_count
  FROM faces f CROSS JOIN photos p ON p.id = f.photo_id WHERE f.known_id IS NOT NULL`;

interface NameRow {
  id: string;
  name: string;
  aliases: string;
}

/**
 * Known personalities that appear in photos the caller can see, with the number of distinct visible photos each.
 * Names are global reference data, but a person is listed only when a visible photo has a matched face, so a
 * viewer never learns names from albums they cannot see. A face counts whether or not it also has a person_id.
 *
 * D1 (2 statements per request, no OFFSET, no N+1): one grouped aggregate that walks idx_faces_known_photo
 * (every known-matched face, about one row read each, bounded by matches rather than all faces) with one
 * photos primary-key lookup per matched face and the visible-albums list materialised once; then one
 * known_people lookup by primary key via json_each over the (at most a few hundred) matched ids. Writes: 0.
 * Worker CPU: sorting and mapping at most the number of distinct known people matched (hundreds), no embeddings.
 */
export async function listKnownRoute(c: Context<{ Bindings: Env }>) {
  const user = userOf(c);
  const scope = scopeFor(user, 'p.album');
  const counts = await c.env.DB.prepare(
    `${KNOWN_COUNTS_SQL}${scope.sql} GROUP BY f.known_id`
  )
    .bind(...scope.params)
    .all<{ id: string; photo_count: number }>();
  if (counts.results.length === 0) return c.json({ known: [] });

  const countById = new Map(counts.results.map((r) => [r.id, r.photo_count]));
  const names = await c.env.DB.prepare(
    'SELECT k.id, k.name, k.aliases FROM json_each(?) j JOIN known_people k ON k.id = j.value'
  )
    .bind(JSON.stringify([...countById.keys()]))
    .all<NameRow>();

  const known = names.results
    .map((r) => ({ id: r.id, name: r.name, aliases: JSON.parse(r.aliases) as string[], photoCount: countById.get(r.id) ?? 0 }))
    .sort((a, b) => b.photoCount - a.photoCount || a.name.localeCompare(b.name));
  return c.json({ known });
}
