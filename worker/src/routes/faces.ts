import type { Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { FACE_SELECT, confirmFacesStmts, serializeFace, type FaceWithJoins } from '../db/faces';

type Ctx = Context<{ Bindings: Env }>;

const personBody = z.object({ personId: z.string().min(1) });

const loadFace = (c: Ctx, id: string) =>
  c.env.DB.prepare(`${FACE_SELECT} WHERE f.id = ?`).bind(id).first<FaceWithJoins>();

const personExists = async (c: Ctx, id: string) =>
  (await c.env.DB.prepare('SELECT id FROM persons WHERE id = ?').bind(id).first()) !== null;

export async function assignFaceRoute(c: Ctx) {
  const parsed = personBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const id = c.req.param('id') as string;
  const { personId } = parsed.data;
  if (!(await loadFace(c, id)) || !(await personExists(c, personId))) return c.text('Not Found', 404);

  await c.env.DB.batch(confirmFacesStmts(c.env.DB, [id], personId));
  return c.json(serializeFace((await loadFace(c, id))!));
}

export async function rejectFaceRoute(c: Ctx) {
  const parsed = personBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const id = c.req.param('id') as string;
  const { personId } = parsed.data;
  if (!(await loadFace(c, id)) || !(await personExists(c, personId))) return c.text('Not Found', 404);

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
  if (!(await loadFace(c, id))) return c.text('Not Found', 404);
  await c.env.DB.prepare(
    "UPDATE faces SET person_id = NULL, match_score = NULL, assign_status = 'unassigned' WHERE id = ?"
  ).bind(id).run();
  return c.json(serializeFace((await loadFace(c, id))!));
}

export async function photoFacesRoute(c: Ctx) {
  const id = c.req.param('id') as string;
  const photo = await c.env.DB.prepare('SELECT id FROM photos WHERE id = ?').bind(id).first();
  if (!photo) return c.text('Not Found', 404);
  const rows = await c.env.DB.prepare(`${FACE_SELECT} WHERE f.photo_id = ? ORDER BY f.bbox_x, f.id`)
    .bind(id)
    .all<FaceWithJoins>();
  return c.json({ faces: rows.results.map(serializeFace) });
}

/** The sharp crop the agent uploaded for a face. Keyed by face id, so the proxy caches it for a day only. */
export async function faceCropRoute(c: Ctx) {
  const row = await c.env.DB.prepare('SELECT crop_key FROM faces WHERE id = ?')
    .bind(c.req.param('id'))
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
