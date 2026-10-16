import type { Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { FACE_SELECT, serializeFace, type FaceRow } from '../db/faces';

type Ctx = Context<{ Bindings: Env }>;

const nameField = z.string().trim().min(1).max(60);
const createBody = z.object({ name: nameField, faceIds: z.array(z.string().min(1)).max(200).optional() });
const renameBody = z.object({ name: nameField });
const bulkBody = z.object({ faceIds: z.array(z.string().min(1)).min(1).max(200) });

export type FaceWithJoins = FaceRow & { person_name: string | null; content_hash: string };

const isUniqueViolation = (err: unknown) => err instanceof Error && /UNIQUE|constraint/i.test(`${err.message} ${(err as any).cause?.message ?? ''}`);

/** Returns true when a person with this name (case-insensitive) already exists, other than `exceptId`. */
async function nameTaken(c: Ctx, name: string, exceptId?: string): Promise<boolean> {
  const row = await c.env.DB.prepare('SELECT id FROM persons WHERE lower(name) = lower(?) AND id != ?')
    .bind(name, exceptId ?? '')
    .first();
  return row !== null;
}

/** Statement that confirms one face for a person (clears the match score). */
export const confirmFaceStmt = (c: Ctx, faceId: string, personId: string) =>
  c.env.DB.prepare(
    "UPDATE faces SET person_id = ?, assign_status = 'confirmed', match_score = NULL WHERE id = ?"
  ).bind(personId, faceId);

export async function listPeopleRoute(c: Ctx) {
  const [people, covers] = await Promise.all([
    c.env.DB.prepare(
      `SELECT p.id, p.name, COUNT(f.id) AS face_count, COUNT(DISTINCT f.photo_id) AS photo_count
       FROM persons p
       LEFT JOIN faces f ON f.person_id = p.id AND f.assign_status IN ('confirmed', 'auto')
       GROUP BY p.id
       ORDER BY face_count DESC, p.name COLLATE NOCASE, p.id`
    ).all<{ id: string; name: string; face_count: number; photo_count: number }>(),
    c.env.DB.prepare(
      `SELECT * FROM (
         ${FACE_SELECT.replace('SELECT f.id,', 'SELECT ROW_NUMBER() OVER (PARTITION BY f.person_id ORDER BY f.det_score DESC, f.id) AS rn, f.id,')}
         WHERE f.assign_status = 'confirmed' AND f.person_id IS NOT NULL
       ) WHERE rn = 1`
    ).all<FaceWithJoins>(),
  ]);
  const coverByPerson = new Map(covers.results.map((r) => [r.person_id as string, serializeFace(r)]));
  return c.json({
    people: people.results.map((p) => ({
      id: p.id,
      name: p.name,
      faceCount: p.face_count,
      photoCount: p.photo_count,
      cover: coverByPerson.get(p.id) ?? null,
    })),
  });
}

export async function createPersonRoute(c: Ctx) {
  const parsed = createBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { name, faceIds } = parsed.data;
  if (await nameTaken(c, name)) return c.json({ error: 'A person with this name already exists' }, 409);

  const id = crypto.randomUUID();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO persons (id, name, created_at) VALUES (?, ?, ?)').bind(id, name, new Date().toISOString()),
      ...(faceIds ?? []).map((fid) => confirmFaceStmt(c, fid, id)),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) return c.json({ error: 'A person with this name already exists' }, 409);
    throw err;
  }
  return c.json({ id, name }, 201);
}

export async function renamePersonRoute(c: Ctx) {
  const parsed = renameBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const id = c.req.param('id') as string;
  const existing = await c.env.DB.prepare('SELECT id FROM persons WHERE id = ?').bind(id).first();
  if (!existing) return c.text('Not Found', 404);
  const { name } = parsed.data;
  if (await nameTaken(c, name, id)) return c.json({ error: 'A person with this name already exists' }, 409);
  try {
    await c.env.DB.prepare('UPDATE persons SET name = ? WHERE id = ?').bind(name, id).run();
  } catch (err) {
    if (isUniqueViolation(err)) return c.json({ error: 'A person with this name already exists' }, 409);
    throw err;
  }
  return c.json({ id, name });
}

export async function deletePersonRoute(c: Ctx) {
  const id = c.req.param('id') as string;
  const existing = await c.env.DB.prepare('SELECT id FROM persons WHERE id = ?').bind(id).first();
  if (!existing) return c.text('Not Found', 404);
  // No foreign keys: dependants are cleaned up explicitly, atomically.
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE faces SET person_id = NULL, match_score = NULL, assign_status = 'unassigned' WHERE person_id = ?"
    ).bind(id),
    c.env.DB.prepare('DELETE FROM face_rejections WHERE person_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM persons WHERE id = ?').bind(id),
  ]);
  return c.body(null, 204);
}

export async function assignFacesRoute(c: Ctx) {
  const parsed = bulkBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const id = c.req.param('id') as string;
  const existing = await c.env.DB.prepare('SELECT id FROM persons WHERE id = ?').bind(id).first();
  if (!existing) return c.text('Not Found', 404);
  const faceIds = [...new Set(parsed.data.faceIds)];
  await c.env.DB.batch([
    ...faceIds.map((fid) => confirmFaceStmt(c, fid, id)),
    ...faceIds.map((fid) => c.env.DB.prepare('DELETE FROM face_rejections WHERE face_id = ? AND person_id = ?').bind(fid, id)),
  ]);
  return c.json({ personId: id, assigned: faceIds.length });
}
