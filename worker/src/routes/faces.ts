import type { Context } from 'hono';
import * as z from 'zod/mini';
import type { Env } from '../types';
import { userOf } from '../access';
import { photoAccess, scopeFor } from '../db/visibility';
import { denial, faceRoles, personRole } from '../db/people';
import { requireFacesOwned } from './people';
import { refreshReferences } from '../people/referenceSelection';
import { FACE_SELECT, PERSON_NAME_SQL, confirmFacesStmts, nameBinds, serializeFace, type FaceWithJoins } from '../db/faces';

type Ctx = Context<{ Bindings: Env }>;

const personBody = z.object({ personId: z.string().check(z.minLength(1)) });

const loadFace = (c: Ctx, id: string) =>
  c.env.DB.prepare(`${FACE_SELECT} WHERE f.id = ?`).bind(...nameBinds(userOf(c)), id).first<FaceWithJoins>();

/**
 * Owner-only face edit gate: the caller must own the face's photo's album and, when a person is named,
 * own that person. 404 when the face (or person) is not visible, 403 when visible but not theirs.
 * D1: 1 statement for the face (PK lookups) plus personRole (1 to 2 reads).
 */
async function gate(c: Ctx, faceId: string, personId?: string): Promise<Response | null> {
  const user = userOf(c);
  const faceRole = (await faceRoles(c.env.DB, user, [faceId])).get(faceId) ?? null;
  const roles = [faceRole];
  if (personId !== undefined) roles.push(await personRole(c.env.DB, user, personId));
  const code = denial(roles);
  if (code === 404) return c.text('Not Found', 404);
  if (code === 403) return c.text('Forbidden', 403);
  return null;
}

export async function assignFaceRoute(c: Ctx) {
  const parsed = personBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: z.flattenError(parsed.error) }, 400);
  const id = c.req.param('id') as string;
  const { personId } = parsed.data;
  const denied = await gate(c, id, personId);
  if (denied) return denied;

  await c.env.DB.batch(confirmFacesStmts(c.env.DB, [id], personId));
  await refreshReferences(c.env.DB, { personIds: [personId], faceIds: [id] });
  return c.json(serializeFace((await loadFace(c, id))!));
}

export async function rejectFaceRoute(c: Ctx) {
  const parsed = personBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: z.flattenError(parsed.error) }, 400);
  const id = c.req.param('id') as string;
  const { personId } = parsed.data;
  const denied = await gate(c, id, personId);
  if (denied) return denied;

  await c.env.DB.batch([
    c.env.DB.prepare('INSERT OR IGNORE INTO face_rejections (face_id, person_id) VALUES (?, ?)').bind(id, personId),
    c.env.DB.prepare(
      "UPDATE faces SET person_id = NULL, match_score = NULL, assign_status = 'unassigned' WHERE id = ? AND person_id = ?"
    ).bind(id, personId),
  ]);
  await refreshReferences(c.env.DB, { faceIds: [id] });
  return c.json(serializeFace((await loadFace(c, id))!));
}

export async function unassignFaceRoute(c: Ctx) {
  const id = c.req.param('id') as string;
  const denied = await gate(c, id);
  if (denied) return denied;
  await c.env.DB.prepare(
    "UPDATE faces SET person_id = NULL, match_score = NULL, assign_status = 'unassigned' WHERE id = ?"
  ).bind(id).run();
  await refreshReferences(c.env.DB, { faceIds: [id] });
  return c.json(serializeFace((await loadFace(c, id))!));
}

/** One page of photos: the person page's largest page size. */
export const MAX_FACE_PHOTOS = 48;

/**
 * One person's confirmed and auto faces on the given photos. The photo ids drive the query, so faces come from
 * idx_faces_photo_id; the unary `+` keeps the planner from walking every face of the person instead. Binds: the two
 * name emails, JSON photo ids, person id, scope params.
 */
export const personPhotoFacesSql = (scopeSql: string) => `SELECT f.id, f.photo_id, f.bbox_x, f.bbox_y, f.bbox_w, f.bbox_h,
  f.det_score, f.person_id, f.assign_status, f.match_score, f.crop_key, f.ignored_at,
  ${PERSON_NAME_SQL} AS person_name, ph.content_hash AS content_hash
  FROM json_each(?) j CROSS JOIN faces f ON f.photo_id = j.value
  JOIN photos ph ON ph.id = f.photo_id LEFT JOIN persons p ON p.id = f.person_id
  WHERE +f.person_id = ? AND +f.assign_status IN ('confirmed', 'auto')${scopeSql}`;

/**
 * A person's faces for a page of photos, instead of one request per photo. An unknown or invisible person or photo
 * simply matches nothing, so no role check is read. D1: 1 statement, 0 writes.
 */
export async function personFacesRoute(c: Ctx) {
  const requested = (c.req.query('photos') ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  const photos = [...new Set(requested)];
  if (photos.length === 0 || photos.length > MAX_FACE_PHOTOS)
    return c.json({ error: `photos must list 1 to ${MAX_FACE_PHOTOS} ids` }, 400);
  const user = userOf(c);
  const access = scopeFor(user, 'ph.album');
  const { results } = await c.env.DB.prepare(personPhotoFacesSql(access.sql))
    .bind(...nameBinds(user), JSON.stringify(photos), c.req.param('id') as string, ...access.params)
    .all<FaceWithJoins>();
  return c.json({ faces: results.map(serializeFace) });
}

const faceIdsBody = z.object({ faceIds: z.array(z.string().check(z.minLength(1))).check(z.minLength(1), z.maxLength(200)) });

/**
 * Only an unnamed face can be ignored, so a face matched meanwhile is skipped. `+` keeps the primary-key lookups.
 * RETURNING counts the faces changed (meta.changes would also count index writes). Binds: time, JSON ids.
 */
export const IGNORE_FACES_SQL = `UPDATE faces SET ignored_at = ? WHERE id IN (SELECT value FROM json_each(?))
  AND +assign_status = 'unassigned' AND +ignored_at IS NULL RETURNING id`;
/** Binds: JSON ids. */
export const RESTORE_FACES_SQL = 'UPDATE faces SET ignored_at = NULL WHERE id IN (SELECT value FROM json_each(?)) AND +ignored_at IS NOT NULL RETURNING id';

/**
 * Shared body of ignore and restore: every face must be in an album the caller owns, else nothing changes.
 * D1: 1 statement for all roles plus 1 set-based UPDATE (primary-key lookups); only changed rows are written.
 */
async function setIgnored(c: Ctx, ignored: boolean): Promise<Response> {
  const parsed = faceIdsBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: z.flattenError(parsed.error) }, 400);
  const faceIds = [...new Set(parsed.data.faceIds)];
  const denied = await requireFacesOwned(c, faceIds);
  if (denied) return denied;
  const stmt = ignored
    ? c.env.DB.prepare(IGNORE_FACES_SQL).bind(new Date().toISOString(), JSON.stringify(faceIds))
    : c.env.DB.prepare(RESTORE_FACES_SQL).bind(JSON.stringify(faceIds));
  const { results } = await stmt.all<{ id: string }>();
  return c.json(ignored ? { ignored: results.length } : { restored: results.length });
}

export const ignoreFacesRoute = (c: Ctx) => setIgnored(c, true);
export const restoreFacesRoute = (c: Ctx) => setIgnored(c, false);

export async function photoFacesRoute(c: Ctx) {
  const id = c.req.param('id') as string;
  const access = photoAccess(userOf(c), 'p');
  const photo = await c.env.DB.prepare(`SELECT p.id FROM photos p${access.join} WHERE p.id = ?${access.where}`)
    .bind(id, ...access.params)
    .first();
  if (!photo) return c.text('Not Found', 404);
  const rows = await c.env.DB.prepare(`${FACE_SELECT} WHERE f.photo_id = ? ORDER BY f.bbox_x, f.id`)
    .bind(...nameBinds(userOf(c)), id)
    .all<FaceWithJoins>();
  return c.json({ faces: rows.results.map(serializeFace) });
}

/** The sharp crop the agent uploaded for a face. Keyed by face id, so the proxy caches it for a day only. */
export async function faceCropRoute(c: Ctx) {
  const access = photoAccess(userOf(c), 'ph');
  const row = await c.env.DB.prepare(
    `SELECT f.crop_key FROM faces f JOIN photos ph ON ph.id = f.photo_id${access.join} WHERE f.id = ?${access.where}`
  )
    .bind(c.req.param('id'), ...access.params)
    .first<{ crop_key: string | null }>();
  if (!row?.crop_key) return c.text('Not Found', 404);
  const object = await c.env.THUMBNAILS.get(row.crop_key);
  if (!object) return c.text('Not Found', 404);
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'image/jpeg',
      'Cache-Control': 'private, max-age=86400',
    },
  });
}
