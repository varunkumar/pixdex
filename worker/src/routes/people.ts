import type { Context } from 'hono';
import * as z from 'zod/mini';
import type { Env } from '../types';
import { embeddingFromBytes } from '../people/embedding';
import { loadReferences } from '../people/references';
import { refreshReferences } from '../people/referenceSelection';
import { FACE_PAGE_SIZE, GROUPS_PAGE_SIZE, MATCHABLE_SQL, bestScore, classify, clusterFaces } from '../people/matching';
import { userOf, type User } from '../access';
import { scopeFor } from '../db/visibility';
import { denial, faceRoles, personRole } from '../db/people';
import { FACE_SELECT, PERSON_NAME_SQL, confirmFacesStmts, nameBinds, serializeFace, type FaceWithJoins } from '../db/faces';

type Ctx = Context<{ Bindings: Env }>;

const nameField = z.string().check(z.trim(), z.minLength(1), z.maxLength(60));
const createBody = z.object({ name: nameField, faceIds: z.optional(z.array(z.string().check(z.minLength(1))).check(z.maxLength(200))) });
const renameBody = z.object({ name: nameField });
const labelBody = z.object({ name: z.string().check(z.trim(), z.minLength(1), z.maxLength(80)) });
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
export async function requireFacesOwned(c: Ctx, faceIds: string[]): Promise<Response | null> {
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
      `SELECT p.id, ${PERSON_NAME_SQL} AS resolved_name, p.owner_email, COUNT(f.id) AS face_count, COUNT(DISTINCT f.photo_id) AS photo_count
       FROM persons p
       LEFT JOIN faces f ON f.person_id = p.id AND f.assign_status IN ('confirmed', 'auto')
         AND EXISTS (SELECT 1 FROM photos ph WHERE ph.id = f.photo_id${scope.sql})
       GROUP BY p.id
       HAVING p.owner_email = ? OR COUNT(f.id) > 0
       ORDER BY resolved_name IS NULL, resolved_name COLLATE NOCASE, p.id`
    )
      .bind(...nameBinds(user), ...scope.params, user.email)
      .all<{ id: string; resolved_name: string | null; owner_email: string | null; face_count: number; photo_count: number }>(),
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
      .bind(...nameBinds(user), ...scope.params)
      .all<FaceWithJoins>(),
  ]);
  const coverByPerson = new Map(covers.results.map((r) => [r.person_id as string, serializeFace(r)]));
  return c.json({
    people: people.results.map((p) => ({
      id: p.id,
      name: p.resolved_name,
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
  if (faceIds?.length) await refreshReferences(c.env.DB, { personIds: [id], faceIds });
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

/**
 * Gate for the viewer label routes: 404 when the caller cannot see the person, 400 for the owner (who renames
 * with PATCH /people/:id), else null. D1: personRole (1 persons PK read plus one bounded probe).
 */
async function requireLabelViewer(c: Ctx, id: string): Promise<Response | null> {
  const role = await personRole(c.env.DB, userOf(c), id);
  if (role === null) return c.text('Not Found', 404);
  if (role === 'owner') return c.json({ error: 'Owners rename their own people with PATCH /people/:id' }, 400);
  return null;
}

/**
 * Sets (upserts) the caller's private name for a person they can see but do not own. Labels are unique per
 * viewer, case-insensitively, among labels only: a label may equal the name of a person the viewer owns.
 * D1: personRole reads, 1 clash probe on idx_person_labels_viewer_name_lower, 1 upsert write (1 row).
 */
export async function putPersonLabelRoute(c: Ctx) {
  const parsed = labelBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: z.flattenError(parsed.error) }, 400);
  const id = c.req.param('id') as string;
  const denied = await requireLabelViewer(c, id);
  if (denied) return denied;
  const viewer = userOf(c).email;
  const { name } = parsed.data;
  const clash = { error: 'You already gave this name to another person' };
  const taken = await c.env.DB.prepare('SELECT 1 AS x FROM person_labels WHERE viewer_email = ? AND lower(name) = lower(?) AND person_id != ?')
    .bind(viewer, name, id)
    .first();
  if (taken) return c.json(clash, 409);
  try {
    await c.env.DB.prepare(
      `INSERT INTO person_labels (viewer_email, person_id, name, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (viewer_email, person_id) DO UPDATE SET name = excluded.name`
    )
      .bind(viewer, id, name, new Date().toISOString())
      .run();
  } catch (err) {
    if (isUniqueViolation(err)) return c.json(clash, 409);
    throw err;
  }
  return c.json({ id, name });
}

/** Clears the caller's private name for a person. Idempotent. D1: personRole reads, 1 PK delete. */
export async function deletePersonLabelRoute(c: Ctx) {
  const id = c.req.param('id') as string;
  const denied = await requireLabelViewer(c, id);
  if (denied) return denied;
  await c.env.DB.prepare('DELETE FROM person_labels WHERE viewer_email = ? AND person_id = ?').bind(userOf(c).email, id).run();
  return c.body(null, 204);
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
    c.env.DB.prepare('DELETE FROM person_references WHERE person_id = ?').bind(id),
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
  await refreshReferences(c.env.DB, { personIds: [id], faceIds });
  return c.json({ personId: id, assigned: faceIds.length });
}

const matchBody = z.object({
  apply: z.optional(z.boolean()),
  // A rowid; `m<rowid>` is the second phase of a narrow match.
  cursor: z.optional(z.string().check(z.regex(/^m?\d+$/))),
  from: z.optional(z.array(z.string().check(z.minLength(1))).check(z.maxLength(50))),
});
const cursorParam = z.string().check(z.regex(/^\d+$/));

interface CandidateRow {
  rid: number;
  id: string;
  embedding: ArrayBuffer;
}

/** Serialized faces for the given ids (no embeddings), keyed by face id. */
async function loadFaces(db: D1Database, user: User, ids: string[]): Promise<Map<string, FaceWithJoins>> {
  const out = new Map<string, FaceWithJoins>();
  if (ids.length === 0) return out;
  const { results } = await db
    .prepare(`${FACE_SELECT} WHERE f.id IN (SELECT value FROM json_each(?))`)
    .bind(...nameBinds(user), JSON.stringify(ids))
    .all<FaceWithJoins>();
  for (const r of results) out.set(r.id, r);
  return out;
}

/**
 * One page of unnamed faces in albums the owner has, in rowid order. Binds: cursor rowid, owner email.
 * INDEXED BY and the CROSS JOINs pin the walk of the not-ignored index: left to itself the planner can pick
 * idx_faces_assign_status (which reads every ignored face) or, with table statistics, start from the albums and
 * sort every candidate.
 */
export const GROUP_CANDIDATES_SQL = `SELECT f.rowid AS rid, f.id, f.embedding FROM faces f INDEXED BY idx_faces_open_status
  CROSS JOIN photos ph ON ph.id = f.photo_id CROSS JOIN albums a ON a.name = ph.album
  WHERE f.assign_status = 'unassigned' AND f.ignored_at IS NULL AND ${MATCHABLE_SQL} AND f.rowid > ? AND a.owner_email = ?
  ORDER BY f.rowid LIMIT ${GROUPS_PAGE_SIZE}`;

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

  const { results } = await c.env.DB.prepare(GROUP_CANDIDATES_SQL)
    .bind(Number(parsedCursor.data), user.email)
    .all<CandidateRow>();

  const clusters = clusterFaces(results.map((r) => ({ id: r.id, embedding: embeddingFromBytes(r.embedding) })));
  const faces = await loadFaces(c.env.DB, user, results.map((r) => r.id));
  return c.json({
    groups: clusters.map((ids) => ({ faces: ids.map((id) => serializeFace(faces.get(id)!)) })),
    scanned: results.length,
    nextCursor: results.length === GROUPS_PAGE_SIZE ? String(results[results.length - 1].rid) : null,
  });
}

/**
 * One page of match candidates: unassigned faces that are not ignored, plus auto faces of other people (only taken on a higher score),
 * in rowid order. Binds: cursor rowid, owner email, person id, person id. The unary `+` keeps SQLite off the
 * assign_status index and the CROSS JOINs keep faces outermost, so it walks rowids from the cursor and stops at the
 * page size. With the index it read and sorted every remaining candidate on every page.
 */
export const MATCH_CANDIDATES_SQL = `SELECT f.rowid AS rid, f.id, f.embedding, f.assign_status, f.match_score FROM faces f
  CROSS JOIN photos ph ON ph.id = f.photo_id CROSS JOIN albums a ON a.name = ph.album
  WHERE ${MATCHABLE_SQL} AND f.rowid > ? AND a.owner_email = ? AND +f.ignored_at IS NULL
    AND (+f.assign_status = 'unassigned' OR (+f.assign_status = 'auto' AND f.person_id != ?))
    AND NOT EXISTS (SELECT 1 FROM face_rejections r WHERE r.face_id = f.id AND r.person_id = ?)
  ORDER BY f.rowid LIMIT ${FACE_PAGE_SIZE}`;

const narrowMatchSql = (source: string, where: string) => `SELECT f.rowid AS rid, f.id, f.embedding, f.assign_status, f.match_score FROM ${source}
  CROSS JOIN photos ph ON ph.id = f.photo_id CROSS JOIN albums a ON a.name = ph.album
  WHERE ${where} AND ${MATCHABLE_SQL} AND f.rowid > ?1 AND a.owner_email = ?2
    AND NOT EXISTS (SELECT 1 FROM face_rejections r WHERE r.face_id = f.id AND r.person_id = ?3)
  ORDER BY f.rowid LIMIT ${FACE_PAGE_SIZE}`;

/*
 * The narrow match (`from` given) runs in two phases, so each walks its own faces once.
 * Binds: ?1 cursor rowid, ?2 owner email, ?3 person id.
 */

/** Phase 1: unassigned faces that are not ignored, through their index (already in rowid order). */
export const MATCH_UNNAMED_SQL = narrowMatchSql(
  'faces f INDEXED BY idx_faces_open_status',
  "f.assign_status = 'unassigned' AND f.ignored_at IS NULL"
);

/**
 * Phase 2: the auto faces of the people in ?4 (a JSON array; a face was just moved away from them). A covering walk of
 * each person's auto faces gives the rowids, then faces are read in that order up to the page size.
 */
export const MATCH_MOVED_SQL = narrowMatchSql(
  'faces f',
  `f.rowid IN (SELECT p.rowid FROM faces p INDEXED BY idx_faces_person_status_created
     WHERE p.person_id IN (SELECT value FROM json_each(?4)) AND p.person_id != ?3 AND p.assign_status = 'auto' AND p.rowid > ?1)
   AND +f.ignored_at IS NULL`
);

export const IGNORED_PAGE_SIZE = 60;

/**
 * One page of the caller's ignored faces, newest first. Binds: caller email x2, then (when `after`) the cursor's
 * ignored_at and rowid, then the owner email. Walks idx_faces_ignored backwards (rowid breaks ties), so there is no
 * sort; ignored faces in other owners' albums are walked past.
 */
export const ignoredFacesSql = (after: boolean) => `${FACE_SELECT.replace('SELECT f.id,', 'SELECT f.rowid AS rid, f.id,')
  .replace('JOIN photos ph ON ph.id = f.photo_id', 'CROSS JOIN photos ph ON ph.id = f.photo_id CROSS JOIN albums a ON a.name = ph.album')}
  WHERE f.ignored_at IS NOT NULL${after ? ' AND (f.ignored_at, f.rowid) < (?, ?)' : ''} AND a.owner_email = ?
  ORDER BY f.ignored_at DESC, f.rowid DESC LIMIT ${IGNORED_PAGE_SIZE}`;

/** `<ignored_at>|<rowid>` of the last face of the previous page. */
const ignoredCursor = z.string().check(z.regex(/^[^|]+\|\d+$/));

/** D1: the owns-an-album probe, then one statement; 0 writes. */
export async function ignoredFacesRoute(c: Ctx) {
  const user = userOf(c);
  const raw = c.req.query('cursor');
  if (raw !== undefined && !ignoredCursor.safeParse(raw).success) return c.json({ error: 'Invalid cursor' }, 400);
  const empty = { faces: [], nextCursor: null };
  const owns = await c.env.DB.prepare('SELECT 1 AS x FROM albums WHERE owner_email = ? LIMIT 1').bind(user.email).first();
  if (!owns) return c.json(empty);

  const [at, rid] = raw?.split('|') ?? [];
  const { results } = await c.env.DB.prepare(ignoredFacesSql(raw !== undefined))
    .bind(...nameBinds(user), ...(raw === undefined ? [] : [at, Number(rid)]), user.email)
    .all<FaceWithJoins & { rid: number }>();
  const last = results[results.length - 1];
  return c.json({
    faces: results.map(serializeFace),
    nextCursor: results.length === IGNORED_PAGE_SIZE ? `${last.ignored_at}|${last.rid}` : null,
  });
}

export const AUTO_PAGE_SIZE = 48;

/** The sort key of the review list; an auto face always has a score, the fallback keeps the keyset total. */
const AUTO_SCORE = 'COALESCE(f2.match_score, -1)';

/**
 * One page of a person's auto faces in albums the owner has, weakest match first. Binds: caller email x2, person id,
 * owner email, then (when `after`) the cursor's score and rowid. The inner query walks the person's auto faces on
 * idx_faces_person_status_created and sorts only (score, rowid); names and details are read for the kept rows.
 */
export const autoFacesSql = (after: boolean) => `${FACE_SELECT.replace('SELECT f.id,', 'SELECT k.score AS score, k.rid AS rid, f.id,')
  .replace(
    'FROM faces f',
    `FROM (SELECT f2.rowid AS rid, ${AUTO_SCORE} AS score FROM faces f2 INDEXED BY idx_faces_person_status_created
    CROSS JOIN photos ph ON ph.id = f2.photo_id CROSS JOIN albums a ON a.name = ph.album
    WHERE f2.person_id = ? AND f2.assign_status = 'auto' AND a.owner_email = ?${after ? ` AND (${AUTO_SCORE}, f2.rowid) > (?, ?)` : ''}
    ORDER BY score, rid LIMIT ${AUTO_PAGE_SIZE}) k CROSS JOIN faces f ON f.rowid = k.rid`
  )}
  ORDER BY k.score, k.rid`;

/** `<score>|<rowid>` of the last face of the previous page. */
const autoCursor = z.string().check(z.regex(/^-?\d+(\.\d+)?(e-?\d+)?\|\d+$/));

/**
 * D1: personRole, then one statement that reads every auto face of the person (with a photo and an album key
 * lookup each) and returns at most AUTO_PAGE_SIZE rows; 0 writes.
 */
export async function autoFacesRoute(c: Ctx) {
  const id = c.req.param('id') as string;
  const raw = c.req.query('cursor');
  if (raw !== undefined && !autoCursor.safeParse(raw).success) return c.json({ error: 'Invalid cursor' }, 400);
  const denied = await requirePersonOwner(c, id);
  if (denied) return denied;
  const user = userOf(c);
  const after = raw === undefined ? [] : raw.split('|').map(Number);
  const { results } = await c.env.DB.prepare(autoFacesSql(raw !== undefined))
    .bind(...nameBinds(user), id, user.email, ...after)
    .all<FaceWithJoins & { score: number; rid: number }>();
  const last = results[results.length - 1];
  return c.json({
    faces: results.map(serializeFace),
    nextCursor: results.length === AUTO_PAGE_SIZE ? `${last.score}|${last.rid}` : null,
  });
}

/**
 * The faces a review may change, checked at write time: still this person's auto match, in an album the owner has.
 * `+` keeps the primary-key lookups. Binds: JSON ids, person id, owner email.
 */
const REVIEWABLE_SQL = `faces.id IN (SELECT value FROM json_each(?)) AND +faces.person_id = ? AND +faces.assign_status = 'auto'
  AND EXISTS (SELECT 1 FROM photos ph JOIN albums a ON a.name = ph.album WHERE ph.id = faces.photo_id AND a.owner_email = ?)`;

export const CONFIRM_AUTO_SQL = `UPDATE faces SET assign_status = 'confirmed', match_score = NULL WHERE ${REVIEWABLE_SQL} RETURNING id`;
/** Binds the person id first (the rejection's column), then REVIEWABLE_SQL's. Runs before REJECT_AUTO_SQL. */
export const REJECT_AUTO_INSERT_SQL = `INSERT OR IGNORE INTO face_rejections (face_id, person_id)
  SELECT faces.id, ? FROM faces WHERE ${REVIEWABLE_SQL}`;
export const REJECT_AUTO_SQL = `UPDATE faces SET person_id = NULL, match_score = NULL, assign_status = 'unassigned'
  WHERE ${REVIEWABLE_SQL} RETURNING id`;

const reviewIds = z.optional(z.array(z.string().check(z.minLength(1))).check(z.maxLength(200)));
const reviewBody = z.object({ confirm: reviewIds, reject: reviewIds });

/**
 * Confirms and rejects the faces the owner reviewed. A face that changed since it was shown is skipped, never taken
 * back. D1: personRole, then one batch of at most 3 set-based statements over primary-key lookups.
 */
export async function reviewAutoFacesRoute(c: Ctx) {
  const parsed = reviewBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: z.flattenError(parsed.error) }, 400);
  const confirm = [...new Set(parsed.data.confirm ?? [])];
  const reject = [...new Set(parsed.data.reject ?? [])];
  const total = confirm.length + reject.length;
  if (total < 1 || total > 200) return c.json({ error: 'Give 1 to 200 face ids' }, 400);
  const confirming = new Set(confirm);
  if (reject.some((faceId) => confirming.has(faceId))) return c.json({ error: 'A face cannot be both confirmed and rejected' }, 400);

  const id = c.req.param('id') as string;
  const denied = await requirePersonOwner(c, id);
  if (denied) return denied;
  const owner = userOf(c).email;
  const db = c.env.DB;
  const statements: D1PreparedStatement[] = [];
  if (confirm.length) statements.push(db.prepare(CONFIRM_AUTO_SQL).bind(JSON.stringify(confirm), id, owner));
  if (reject.length) {
    const ids = JSON.stringify(reject);
    statements.push(db.prepare(REJECT_AUTO_INSERT_SQL).bind(id, ids, id, owner), db.prepare(REJECT_AUTO_SQL).bind(ids, id, owner));
  }
  const rejectAt = statements.length - 1;
  const results = await db.batch<{ id: string }>(statements);
  const changed = (index: number) => results[index].results.map((r) => r.id);
  const confirmed = confirm.length ? changed(0) : [];
  // Only confirming changes confirmed faces: a rejected auto match was never a reference.
  if (confirmed.length) await refreshReferences(db, { personIds: [id] });
  return c.json({ confirmed, rejected: reject.length ? changed(rejectAt) : [] });
}

export async function matchPersonRoute(c: Ctx) {
  const parsed = matchBody.safeParse((await c.req.json().catch(() => ({}))) ?? {});
  if (!parsed.success) return c.json({ error: z.flattenError(parsed.error) }, 400);
  const id = c.req.param('id') as string;
  const denied = await requirePersonOwner(c, id);
  if (denied) return denied;
  const owner = userOf(c).email;

  const empty = { auto: [], suggestions: [], scanned: 0, nextCursor: null };
  // The second phase only exists for a narrow match.
  if (parsed.data.cursor?.startsWith('m') && !parsed.data.from?.length) return c.json({ error: 'Invalid cursor' }, 400);

  const { from } = parsed.data;
  // The first page of Re-run matching (applies, checks everything) repairs this person's references first.
  if (parsed.data.apply && !from && parsed.data.cursor === undefined) {
    await refreshReferences(c.env.DB, { personIds: [id] });
  }
  const [refs] = await loadReferences(c.env.DB, { personId: id });
  if (!refs) return c.json(empty);

  const raw = parsed.data.cursor ?? '0';
  const moved = raw.startsWith('m');
  const cursor = Number(moved ? raw.slice(1) : raw);
  const db = c.env.DB;
  const page = !from
    ? db.prepare(MATCH_CANDIDATES_SQL).bind(cursor, owner, id, id)
    : moved
      ? db.prepare(MATCH_MOVED_SQL).bind(cursor, owner, id, JSON.stringify(from))
      : db.prepare(MATCH_UNNAMED_SQL).bind(cursor, owner, id);
  const { results } = await page.all<CandidateRow & { assign_status: string; match_score: number | null }>();

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
         WHERE faces.id = x.id AND faces.assign_status != 'confirmed' AND +faces.ignored_at IS NULL
           AND (faces.assign_status = 'unassigned' OR faces.match_score IS NULL OR x.s > faces.match_score)
           AND NOT EXISTS (SELECT 1 FROM face_rejections r WHERE r.face_id = faces.id AND r.person_id = ?)`
      )
        .bind(JSON.stringify(auto.map((m) => ({ id: m.id, score: m.score }))), id, id)
        .run();
    }
  }

  const faces = await loadFaces(c.env.DB, userOf(c), [...auto, ...suggestions].map((m) => m.id));
  const present = (list: { id: string; score: number }[]) =>
    [...list]
      .sort((a, b) => b.score - a.score)
      .map((m) => ({ ...serializeFace(faces.get(m.id)!), matchScore: m.score }));
  return c.json({
    auto: present(auto),
    suggestions: present(suggestions),
    scanned: results.length,
    nextCursor:
      results.length === FACE_PAGE_SIZE
        ? `${moved ? 'm' : ''}${results[results.length - 1].rid}`
        : !moved && from?.length
          ? 'm0'
          : null,
  });
}
