import type { Context } from 'hono';
import * as z from 'zod/mini';
import type { Env } from '../types';
import { userOf } from '../access';
import { photoAccess } from '../db/visibility';
import { denial, faceRoles, personRole } from '../db/people';
import { FACE_SELECT, confirmFacesStmts, nameBinds, serializeFace, type FaceWithJoins } from '../db/faces';

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
  return c.json(serializeFace((await loadFace(c, id))!));
}

export async function unassignFaceRoute(c: Ctx) {
  const id = c.req.param('id') as string;
  const denied = await gate(c, id);
  if (denied) return denied;
  await c.env.DB.prepare(
    "UPDATE faces SET person_id = NULL, match_score = NULL, assign_status = 'unassigned' WHERE id = ?"
  ).bind(id).run();
  return c.json(serializeFace((await loadFace(c, id))!));
}

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
