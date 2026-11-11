import type { Context } from 'hono';
import * as z from 'zod/mini';
import type { Env } from '../types';
import { embeddingFromBytes } from '../people/embedding';
import { loadReferences } from '../people/references';
import { FACE_PAGE_SIZE, GROUPS_PAGE_SIZE, MATCHABLE_SQL, bestScore, classify, clusterFaces } from '../people/matching';
import { userOf } from '../access';
import { scopeFor } from '../db/visibility';
import { denial, faceRoles, personRole } from '../db/people';
import { FACE_SELECT, confirmFacesStmts, serializeFace, type FaceWithJoins } from '../db/faces';

type Ctx = Context<{ Bindings: Env }>;

const nameField = z.string().check(z.trim(), z.minLength(1), z.maxLength(60));
const createBody = z.object({ name: nameField, faceIds: z.optional(z.array(z.string().check(z.minLength(1))).check(z.maxLength(200))) });
const renameBody = z.object({ name: nameField });
const coverBody = z.object({ faceId: z.string().check(z.minLength(1)) });
const bulkBody = z.object({ faceIds: z.array(z.string().check(z.minLength(1))).check(z.minLength(1), z.maxLength(200)) });

const isUniqueViolation = (err: unknown) => err instanceof Error && /UNIQUE|constraint/i.test(`${err.message} ${(err as any).cause?.message ?? ''}`);

/** Whether this owner already has a person with this name (case-insensitive), other than `exceptId`. Index search on (owner_email, lower(name)). */
async function nameTaken(c: Ctx, owner: string, name: string, exceptId?: string): Promise<boolean> {
  const row = await c.env.DB.prepare('SELECT id FROM persons WHERE owner_email = ? AND lower(name) = lower(?) AND id != ?')
    .bind(owner, name, exceptId ?? '')
    .first();
  return row !== null;
}

/** 404 when the person is not visible to the caller, 403 when visible but not theirs, else null. */
async function requirePersonOwner(c: Ctx, id: string): Promise<Response | null> {
  const code = denial([await personRole(c.env.DB, userOf(c), id)]);
  if (code === 404) return c.text('Not Found', 404);
  if (code === 403) return c.text('Forbidden', 403);
  return null;
}

/** 404 when any face is unknown or not visible, 403 when visible but its album is not the caller's. One statement. */
async function requireFacesOwned(c: Ctx, faceIds: string[]): Promise<Response | null> {
  const roles = await faceRoles(c.env.DB, userOf(c), faceIds);
  const unknown = faceIds.filter((id) => !roles.get(id));
  if (unknown.length) return c.json({ error: `Unknown face ids: ${unknown.join(', ')}` }, 404);
  if (faceIds.some((id) => roles.get(id) !== 'owner')) return c.json({ error: 'Forbidden' }, 403);
  return null;
}

/**
 * People the caller owns (even with no visible faces) plus other owners' people with at least one
 * confirmed or auto face in a photo the caller can see; counts only cover visible photos.
 * D1: persons scan (small table) + faces via idx_faces_person_status_created with a photos/albums PK lookup per
 * counted face; the cover query adds one pass over visible assigned faces.
 */
export async function listPeopleRoute(c: Ctx) {
  const user = userOf(c);
  const scope = scopeFor(user, 'ph.album');
  const [people, covers] = await Promise.all([
    c.env.DB.prepare(
      `SELECT p.id, p.name, p.owner_email, COUNT(f.id) AS face_count, COUNT(DISTINCT f.photo_id) AS photo_count
       FROM persons p
       LEFT JOIN faces f ON f.person_id = p.id AND f.assign_status IN ('confirmed', 'auto')
         AND EXISTS (SELECT 1 FROM photos ph WHERE ph.id = f.photo_id${scope.sql})
       GROUP BY p.id
       HAVING p.owner_email = ? OR COUNT(f.id) > 0
       ORDER BY p.name COLLATE NOCASE, p.id`
    )
      .bind(...scope.params, user.email)
      .all<{ id: string; name: string; owner_email: string | null; face_count: number; photo_count: number }>(),
    // Cover: the owner's pick while that face is still assigned to the person, otherwise the
    // biggest confirmed face (a larger box means more pixels in the 400 px thumbnail), then the
    // most certain detection.
    c.env.DB.prepare(
      `SELECT * FROM (
         ${FACE_SELECT.replace(
           'SELECT f.id,',
           `SELECT ROW_NUMBER() OVER (
              PARTITION BY f.person_id
              ORDER BY (f.id = p.cover_face_id) DESC, (f.assign_status = 'confirmed') DESC,
                       f.bbox_w * f.bbox_h DESC, f.det_score DESC, f.id
            ) AS rn, f.id,`
         )}
         WHERE f.assign_status IN ('confirmed', 'auto') AND f.person_id IS NOT NULL${scope.sql}
       ) WHERE rn = 1`
    )
      .bind(...scope.params)
      .all<FaceWithJoins>(),
  ]);
  const coverByPerson = new Map(covers.results.map((r) => [r.person_id as string, serializeFace(r)]));
  return c.json({
    people: people.results.map((p) => ({
      id: p.id,
      name: p.name,
      faceCount: p.face_count,
      photoCount: p.photo_count,
      canEdit: p.owner_email !== null && p.owner_email === user.email,
      cover: coverByPerson.get(p.id) ?? null,
    })),
  });
}

/** Sets the person's cover to one of their own faces (confirmed or auto). */
export async function setPersonCoverRoute(c: Ctx) {
  const id = c.req.param('id') as string;
  const parsed = coverBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: z.flattenError(parsed.error) }, 400);
  const { faceId } = parsed.data;

  const denied = await requirePersonOwner(c, id);
  if (denied) return denied;
  const face = await c.env.DB.prepare(
    "SELECT id FROM faces WHERE id = ? AND person_id = ? AND assign_status IN ('confirmed', 'auto')"
  )
    .bind(faceId, id)
    .first();
  if (!face) return c.json({ error: 'Face is not assigned to this person' }, 404);

  await c.env.DB.prepare('UPDATE persons SET cover_face_id = ? WHERE id = ?').bind(faceId, id).run();
  return c.json({ coverFaceId: faceId });
}

export async function createPersonRoute(c: Ctx) {
  const parsed = createBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: z.flattenError(parsed.error) }, 400);
  const { name, faceIds } = parsed.data;
  const owner = userOf(c).email;
  if (await nameTaken(c, owner, name)) return c.json({ error: 'A person with this name already exists' }, 409);

  const denied = await requireFacesOwned(c, [...new Set(faceIds ?? [])]);
  if (denied) return denied;

  const id = crypto.randomUUID();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO persons (id, name, owner_email, created_at) VALUES (?, ?, ?, ?)').bind(id, name, owner, new Date().toISOString()),
      ...(faceIds && faceIds.length ? confirmFacesStmts(c.env.DB, [...new Set(faceIds)], id) : []),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) return c.json({ error: 'A person with this name already exists' }, 409);
    throw err;
  }
  return c.json({ id, name }, 201);
}

export async function renamePersonRoute(c: Ctx) {
  const parsed = renameBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: z.flattenError(parsed.error) }, 400);
  const id = c.req.param('id') as string;
  const denied = await requirePersonOwner(c, id);
  if (denied) return denied;
  const { name } = parsed.data;
  if (await nameTaken(c, userOf(c).email, name, id)) return c.json({ error: 'A person with this name already exists' }, 409);
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
  const denied = await requirePersonOwner(c, id);
  if (denied) return denied;
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
  if (!parsed.success) return c.json({ error: z.flattenError(parsed.error) }, 400);
  const id = c.req.param('id') as string;
  const denied = await requirePersonOwner(c, id);
  if (denied) return denied;
  const faceIds = [...new Set(parsed.data.faceIds)];
  const facesDenied = await requireFacesOwned(c, faceIds);
  if (facesDenied) return facesDenied;
  await c.env.DB.batch(confirmFacesStmts(c.env.DB, faceIds, id));
  return c.json({ personId: id, assigned: faceIds.length });
}

const matchBody = z.object({ apply: z.optional(z.boolean()), cursor: z.optional(z.string().check(z.regex(/^\d+$/))) });
const cursorParam = z.string().check(z.regex(/^\d+$/));

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
  // Unassigned faces in albums the caller owns only (nothing for a pure viewer).
  const user = userOf(c);
  const raw = c.req.query('cursor');
  const parsedCursor = raw === undefined ? { success: true as const, data: '0' } : cursorParam.safeParse(raw);
  if (!parsedCursor.success) return c.json({ error: 'Invalid cursor' }, 400);

  // Without an owned album the face scan below could never match: skip it (one covering-index probe) instead of
  // walking every unassigned face with two primary-key lookups each.
  const owns = await c.env.DB.prepare('SELECT 1 AS x FROM albums WHERE owner_email = ? LIMIT 1').bind(user.email).first();
  if (!owns) return c.json({ groups: [], scanned: 0, nextCursor: null });

  const { results } = await c.env.DB.prepare(
    `SELECT f.rowid AS rid, f.id, f.embedding FROM faces f
     JOIN photos ph ON ph.id = f.photo_id JOIN albums a ON a.name = ph.album
     WHERE f.assign_status = 'unassigned' AND ${MATCHABLE_SQL} AND f.rowid > ? AND a.owner_email = ?
     ORDER BY f.rowid LIMIT ${GROUPS_PAGE_SIZE}`
  )
    .bind(Number(parsedCursor.data), user.email)
    .all<CandidateRow>();

  const clusters = clusterFaces(results.map((r) => ({ id: r.id, embedding: embeddingFromBytes(r.embedding) })));
  const faces = await loadFaces(c.env.DB, results.map((r) => r.id));
  return c.json({
    groups: clusters.map((ids) => ({ faces: ids.map((id) => serializeFace(faces.get(id)!)) })),
    scanned: results.length,
    nextCursor: results.length === GROUPS_PAGE_SIZE ? String(results[results.length - 1].rid) : null,
  });
}

export async function matchPersonRoute(c: Ctx) {
  const parsed = matchBody.safeParse((await c.req.json().catch(() => ({}))) ?? {});
  if (!parsed.success) return c.json({ error: z.flattenError(parsed.error) }, 400);
  const id = c.req.param('id') as string;
  const denied = await requirePersonOwner(c, id);
  if (denied) return denied;
  const owner = userOf(c).email;

  const empty = { auto: [], suggestions: [], scanned: 0, nextCursor: null };
  const [refs] = await loadReferences(c.env.DB, { personId: id });
  if (!refs) return c.json(empty);

  // Unassigned faces, plus auto faces of other people (only taken on a higher score).
  const { results } = await c.env.DB.prepare(
    `SELECT f.rowid AS rid, f.id, f.embedding, f.assign_status, f.match_score FROM faces f
     JOIN photos ph ON ph.id = f.photo_id JOIN albums a ON a.name = ph.album
     WHERE ${MATCHABLE_SQL} AND f.rowid > ? AND a.owner_email = ?
       AND (f.assign_status = 'unassigned' OR (f.assign_status = 'auto' AND f.person_id != ?))
       AND NOT EXISTS (SELECT 1 FROM face_rejections r WHERE r.face_id = f.id AND r.person_id = ?)
     ORDER BY f.rowid LIMIT ${FACE_PAGE_SIZE}`
  )
    .bind(Number(parsed.data.cursor ?? '0'), owner, id, id)
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
    // One statement for the whole page. Re-checks the rules at write time: never touch a
    // confirmed face or a rejected pair, and take another person's auto face only on a higher score.
    if (auto.length > 0) {
      await c.env.DB.prepare(
        `WITH x AS (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.score') AS s FROM json_each(?))
         UPDATE faces SET person_id = ?, assign_status = 'auto', match_score = x.s
         FROM x
         WHERE faces.id = x.id AND faces.assign_status != 'confirmed'
           AND (faces.assign_status = 'unassigned' OR faces.match_score IS NULL OR x.s > faces.match_score)
           AND NOT EXISTS (SELECT 1 FROM face_rejections r WHERE r.face_id = faces.id AND r.person_id = ?)`
      )
        .bind(JSON.stringify(auto.map((m) => ({ id: m.id, score: m.score }))), id, id)
        .run();
    }
  }

  const faces = await loadFaces(c.env.DB, [...auto, ...suggestions].map((m) => m.id));
  const present = (list: { id: string; score: number }[]) =>
    [...list]
      .sort((a, b) => b.score - a.score)
      .map((m) => ({ ...serializeFace(faces.get(m.id)!), matchScore: m.score }));
  return c.json({
    auto: present(auto),
    suggestions: present(suggestions),
    scanned: results.length,
    nextCursor: results.length === FACE_PAGE_SIZE ? String(results[results.length - 1].rid) : null,
  });
}
