import type { Context } from 'hono';
import type { Env } from '../types';
import { userOf } from '../access';
import { scopeFor } from '../db/visibility';
import { PERSON_NAME_SQL, nameBinds, serializeFace, type FaceRow, type SerializedFace } from '../db/faces';

export const MAX_TILES = 200;

export interface AlbumPersonTile {
  id: string;
  name: string | null;
  canEdit: boolean;
  photoCount: number;
  cover: SerializedFace | null;
}
export interface AlbumKnownTile {
  id: string;
  name: string;
  photoCount: number;
  cover: SerializedFace | null;
}
export interface AlbumSpeciesTile {
  scientific: string;
  common: string;
  photoCount: number;
  coverPhotoId: string;
  thumbnailUrl: string;
}

/** Wraps photos.species so malformed JSON yields no rows (SQLite does not order AND terms). */
const SPECIES_EACH = `json_each(CASE WHEN json_valid(ph.species) THEN ph.species ELSE '[]' END)`;

/** People in the album (auto or confirmed faces only), photo-driven from idx_photos_album. Binds: email, name x2, album, scope. */
export const PEOPLE_COUNTS_SQL = (scopeSql: string) => `SELECT f.person_id AS id, COUNT(DISTINCT f.photo_id) AS photo_count,
  p.owner_email = ? AS can_edit, ${PERSON_NAME_SQL} AS name
  FROM photos ph CROSS JOIN faces f ON f.photo_id = ph.id JOIN persons p ON p.id = f.person_id
  WHERE ph.album = ?${scopeSql} AND f.assign_status IN ('auto', 'confirmed')
  GROUP BY f.person_id ORDER BY photo_count DESC, name COLLATE NOCASE, f.person_id LIMIT ${MAX_TILES}`;

export const KNOWN_COUNTS_ALBUM_SQL = (scopeSql: string) => `SELECT f.known_id AS id, k.name AS name, COUNT(DISTINCT f.photo_id) AS photo_count
  FROM photos ph CROSS JOIN faces f ON f.photo_id = ph.id JOIN known_people k ON k.id = f.known_id
  WHERE ph.album = ?${scopeSql} AND f.known_id IS NOT NULL AND +f.ignored_at IS NULL
  GROUP BY f.known_id ORDER BY photo_count DESC, k.name COLLATE NOCASE, f.person_id LIMIT ${MAX_TILES}`;

/**
 * Ignored faces are filtered with `+` so the partial known-face index cannot take over these photo-driven plans.
 * One cover face per key (person_id or known_id): a window function over the album's faces, no per-tile query.
 * The inner query selects only keys and ranking columns; the person name (a person_labels probe for people the caller
 * does not own) is computed once per kept cover in the outer SELECT, not per face row. Binds: email x2, album, scope.
 */
const coversSql = (keyCol: string, extraWhere: string, order: string, scopeSql: string, joinPersons: boolean) => `SELECT w.key, w.id, w.photo_id,
  w.bbox_x, w.bbox_y, w.bbox_w, w.bbox_h, w.det_score, w.person_id, w.assign_status, w.match_score, w.crop_key,
  ${PERSON_NAME_SQL} AS person_name, w.content_hash
  FROM (
  SELECT f.${keyCol} AS key, f.id, f.photo_id, f.bbox_x, f.bbox_y, f.bbox_w, f.bbox_h, f.det_score, f.person_id,
    f.assign_status, f.match_score, f.crop_key, ph.content_hash AS content_hash,
    ROW_NUMBER() OVER (PARTITION BY f.${keyCol} ORDER BY ${order}) AS rn
  FROM photos ph CROSS JOIN faces f ON f.photo_id = ph.id${joinPersons ? ' LEFT JOIN persons p ON p.id = f.person_id' : ''}
  WHERE ph.album = ?${scopeSql} AND ${extraWhere}
) w LEFT JOIN persons p ON p.id = w.person_id WHERE w.rn = 1`;

export const PEOPLE_COVERS_SQL = (scopeSql: string) =>
  coversSql(
    'person_id',
    `f.assign_status IN ('auto', 'confirmed')`,
    `(f.id = p.cover_face_id) DESC, (f.assign_status = 'confirmed') DESC, f.det_score DESC, f.id`,
    scopeSql,
    true
  );
export const KNOWN_COVERS_SQL = (scopeSql: string) =>
  coversSql('known_id', 'f.known_id IS NOT NULL AND +f.ignored_at IS NULL', 'f.known_score DESC, f.det_score DESC, f.id', scopeSql, false);

/** Species grouped by scientific name; the bare columns (common, pid, h) come from the row holding MAX(score). */
export const SPECIES_SQL = (scopeSql: string) => `SELECT sci AS scientific, com AS common, pid, h, COUNT(DISTINCT pid) AS photo_count, MAX(score) AS best FROM (
  SELECT ph.id AS pid, ph.content_hash AS h, CASE WHEN j.type = 'object' THEN json_extract(j.value, '$.scientific') END AS sci,
    CASE WHEN j.type = 'object' THEN json_extract(j.value, '$.common') END AS com,
    CASE WHEN j.type = 'object' THEN COALESCE(json_extract(j.value, '$.score'), 0) ELSE 0 END AS score
  FROM photos ph, ${SPECIES_EACH} j
  WHERE ph.album = ?${scopeSql} 
) WHERE sci IS NOT NULL GROUP BY sci ORDER BY photo_count DESC, sci COLLATE NOCASE LIMIT ${MAX_TILES}`;

type CoverRow = FaceRow & { key: string; person_name: string | null; content_hash: string };

/**
 * Contents of one album for the viewer: people, known personalities and species, each capped at 200.
 *
 * D1 (one batch, 6 statements, no N+1, 0 writes): a visibility check (albums primary key plus json_each over one
 * row), then five photo-driven statements that start from idx_photos_album and probe faces via idx_faces_photo_id
 * (or json_each over photos.species). Rows read are bounded by the album's photos and faces; the person-name
 * label lookup runs once per people-count row and once per kept cover (never per face row), only for people the
 * caller does not own. Worker CPU: mapping at most 200 tiles per list.
 */
export async function albumContentsRoute(c: Context<{ Bindings: Env }>) {
  const name = c.req.query('name') ?? '';
  if (!name) return c.json({ error: 'name is required' }, 400);
  const user = userOf(c);
  const scope = scopeFor(user, 'ph.album');
  const names = nameBinds(user);
  const db = c.env.DB;
  const vis = scopeFor(user, 'name');

  const res = await db.batch([
    db.prepare(`SELECT 1 AS ok FROM albums WHERE name = ?${vis.sql}`).bind(name, ...vis.params),
    db.prepare(PEOPLE_COUNTS_SQL(scope.sql)).bind(user.email, ...names, name, ...scope.params),
    db.prepare(KNOWN_COUNTS_ALBUM_SQL(scope.sql)).bind(name, ...scope.params),
    db.prepare(SPECIES_SQL(scope.sql)).bind(name, ...scope.params),
    db.prepare(PEOPLE_COVERS_SQL(scope.sql)).bind(...names, name, ...scope.params),
    db.prepare(KNOWN_COVERS_SQL(scope.sql)).bind(...names, name, ...scope.params),
  ]);
  if (res[0].results.length === 0) return c.json({ error: 'Not found' }, 404);

  const coverMap = (rows: unknown[]) => new Map((rows as CoverRow[]).map((r) => [r.key, serializeFace(r)]));
  const personCovers = coverMap(res[4].results);
  const knownCovers = coverMap(res[5].results);

  const people: AlbumPersonTile[] = (res[1].results as any[]).map((r) => ({
    id: r.id,
    name: r.name ?? null,
    canEdit: !!r.can_edit,
    photoCount: r.photo_count,
    cover: personCovers.get(r.id) ?? null,
  }));
  const known: AlbumKnownTile[] = (res[2].results as any[]).map((r) => ({
    id: r.id,
    name: r.name,
    photoCount: r.photo_count,
    cover: knownCovers.get(r.id) ?? null,
  }));
  const species: AlbumSpeciesTile[] = (res[3].results as any[]).map((r) => ({
    scientific: r.scientific,
    common: r.common ?? r.scientific,
    photoCount: r.photo_count,
    coverPhotoId: r.pid,
    thumbnailUrl: `/thumbnails/${r.h}`,
  }));
  return c.json({ people, known, species });
}
