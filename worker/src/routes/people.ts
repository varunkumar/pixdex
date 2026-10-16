import type { Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { embeddingFromBytes } from '../people/embedding';
import { loadReferences } from '../people/references';
import { FACE_PAGE_SIZE, MATCHABLE_SQL, bestScore, classify, clusterFaces } from '../people/matching';
import { FACE_SELECT, confirmFaceStmt, missingFaceIds, serializeFace, type FaceWithJoins } from '../db/faces';

type Ctx = Context<{ Bindings: Env }>;

const nameField = z.string().trim().min(1).max(60);
const createBody = z.object({ name: nameField, faceIds: z.array(z.string().min(1)).max(200).optional() });
const renameBody = z.object({ name: nameField });
const bulkBody = z.object({ faceIds: z.array(z.string().min(1)).min(1).max(200) });

const isUniqueViolation = (err: unknown) => err instanceof Error && /UNIQUE|constraint/i.test(`${err.message} ${(err as any).cause?.message ?? ''}`);

/** Returns true when a person with this name (case-insensitive) already exists, other than `exceptId`. */
async function nameTaken(c: Ctx, name: string, exceptId?: string): Promise<boolean> {
  const row = await c.env.DB.prepare('SELECT id FROM persons WHERE lower(name) = lower(?) AND id != ?')
    .bind(name, exceptId ?? '')
    .first();
  return row !== null;
}

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

  const missing = await missingFaceIds(c.env.DB, [...new Set(faceIds ?? [])]);
  if (missing.length) return c.json({ error: `Unknown face ids: ${missing.join(', ')}` }, 404);

  const id = crypto.randomUUID();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO persons (id, name, created_at) VALUES (?, ?, ?)').bind(id, name, new Date().toISOString()),
      ...(faceIds ?? []).map((fid) => confirmFaceStmt(c.env.DB, fid, id)),
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
  const missing = await missingFaceIds(c.env.DB, faceIds);
  if (missing.length) return c.json({ error: `Unknown face ids: ${missing.join(', ')}` }, 404);
  await c.env.DB.batch([
    ...faceIds.map((fid) => confirmFaceStmt(c.env.DB, fid, id)),
    ...faceIds.map((fid) => c.env.DB.prepare('DELETE FROM face_rejections WHERE face_id = ? AND person_id = ?').bind(fid, id)),
  ]);
  return c.json({ personId: id, assigned: faceIds.length });
}

const matchBody = z.object({ apply: z.boolean().optional(), cursor: z.string().regex(/^\d+$/).optional() });
const cursorParam = z.string().regex(/^\d+$/);

interface CandidateRow {
  rid: number;
  id: string;
  embedding: ArrayBuffer;
}

/** Serialized faces for the given ids (no embeddings), keyed by face id. */
async function loadFaces(db: D1Database, ids: string[]): Promise<Map<string, FaceWithJoins>> {
  const out = new Map<string, FaceWithJoins>();
  if (ids.length === 0) return out;
  const { results } = await db
    .prepare(`${FACE_SELECT} WHERE f.id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(ids))
    .all<FaceWithJoins>();
  for (const r of results) out.set(r.id, r);
  return out;
}

export async function groupsRoute(c: Ctx) {
  const raw = c.req.query('cursor');
  const parsedCursor = raw === undefined ? { success: true as const, data: '0' } : cursorParam.safeParse(raw);
  if (!parsedCursor.success) return c.json({ error: 'Invalid cursor' }, 400);

  const { results } = await c.env.DB.prepare(
    `SELECT rowid AS rid, id, embedding FROM faces
     WHERE assign_status = 'unassigned' AND ${MATCHABLE_SQL} AND rowid > ?
     ORDER BY rowid LIMIT ${FACE_PAGE_SIZE}`
  )
    .bind(Number(parsedCursor.data))
    .all<CandidateRow>();

  const clusters = clusterFaces(results.map((r) => ({ id: r.id, embedding: embeddingFromBytes(r.embedding) })));
  const faces = await loadFaces(c.env.DB, results.map((r) => r.id));
  return c.json({
    groups: clusters.map((ids) => ({ faces: ids.map((id) => serializeFace(faces.get(id)!)) })),
    scanned: results.length,
    nextCursor: results.length === FACE_PAGE_SIZE ? String(results[results.length - 1].rid) : null,
  });
}

export async function matchPersonRoute(c: Ctx) {
  const parsed = matchBody.safeParse((await c.req.json().catch(() => ({}))) ?? {});
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const id = c.req.param('id') as string;
  const existing = await c.env.DB.prepare('SELECT id FROM persons WHERE id = ?').bind(id).first();
  if (!existing) return c.text('Not Found', 404);

  const empty = { auto: [], suggestions: [], scanned: 0, nextCursor: null };
  const [refs] = await loadReferences(c.env.DB, { personId: id });
  if (!refs) return c.json(empty);

  // Unassigned faces, plus auto faces of other people (only taken on a higher score).
  const { results } = await c.env.DB.prepare(
    `SELECT rowid AS rid, id, embedding, assign_status, match_score FROM faces
     WHERE ${MATCHABLE_SQL} AND rowid > ?
       AND (assign_status = 'unassigned' OR (assign_status = 'auto' AND person_id != ?))
       AND NOT EXISTS (SELECT 1 FROM face_rejections r WHERE r.face_id = faces.id AND r.person_id = ?)
     ORDER BY rowid LIMIT ${FACE_PAGE_SIZE}`
  )
    .bind(Number(parsed.data.cursor ?? '0'), id, id)
    .all<CandidateRow & { assign_status: string; match_score: number | null }>();

  const auto: { id: string; score: number }[] = [];
  const suggestions: { id: string; score: number }[] = [];
  for (const r of results) {
    const score = bestScore(embeddingFromBytes(r.embedding), refs.vectors);
    if (r.assign_status === 'auto' && !(score > (r.match_score ?? -1))) continue;
    const kind = classify(score);
    if (kind === 'auto') auto.push({ id: r.id, score });
    else if (kind === 'suggest') suggestions.push({ id: r.id, score });
  }

  if (parsed.data.apply) {
    for (let i = 0; i < auto.length; i += 100) {
      await c.env.DB.batch(
        auto.slice(i, i + 100).map((m) =>
          c.env.DB.prepare(
            "UPDATE faces SET person_id = ?, assign_status = 'auto', match_score = ? WHERE id = ? AND assign_status != 'confirmed'"
          ).bind(id, m.score, m.id)
        )
      );
    }
  }

  const faces = await loadFaces(c.env.DB, [...auto, ...suggestions].map((m) => m.id));
  const present = (list: { id: string; score: number }[]) =>
    list
      .sort((a, b) => b.score - a.score)
      .map((m) => ({ ...serializeFace(faces.get(m.id)!), matchScore: m.score }));
  return c.json({
    auto: present(auto),
    suggestions: present(suggestions),
    scanned: results.length,
    nextCursor: results.length === FACE_PAGE_SIZE ? String(results[results.length - 1].rid) : null,
  });
}
