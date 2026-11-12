import type { Context } from 'hono';
import * as z from 'zod/mini';
import type { Env } from '../types';

const upsertSchema = z.object({
  people: z
    .array(
      z.object({
        id: z.string().check(z.minLength(1), z.maxLength(64)),
        name: z.string().check(z.minLength(1), z.maxLength(200)),
        aliases: z.array(z.string().check(z.minLength(1), z.maxLength(100))).check(z.maxLength(20)),
      })
    )
    .check(z.minLength(1), z.maxLength(500)),
});

async function readJson(c: Context<{ Bindings: Env }>): Promise<unknown | undefined> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/**
 * Upserts the known-people list in one statement (json_each batching, at most 500 rows).
 * created_at is kept on update. The agent is the only caller (ingest token).
 */
export async function upsertKnownPeopleRoute(c: Context<{ Bindings: Env }>) {
  const body = await readJson(c);
  if (body === undefined) return c.json({ error: 'Invalid JSON body' }, 400);
  const parsed = upsertSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: z.flattenError(parsed.error) }, 400);
  const { people } = parsed.data;

  const payload = JSON.stringify(
    people.map((p) => ({ id: p.id, name: p.name, aliases: JSON.stringify(p.aliases) }))
  );
  await c.env.DB.prepare(
    `INSERT INTO known_people (id, name, aliases, created_at)
     SELECT json_extract(value, '$.id'), json_extract(value, '$.name'), json_extract(value, '$.aliases'), ?
     FROM json_each(?) WHERE true
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, aliases = excluded.aliases`
  )
    .bind(new Date().toISOString(), payload)
    .run();

  return c.json({ upserted: people.length });
}

const embeddingsSchema = z.object({
  model: z.string().check(z.minLength(1), z.maxLength(100)),
  cursor: z.optional(z.number().check(z.int(), z.minimum(0))),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(100))),
  rescore: z.optional(z.boolean()),
});

const ID_BYTES = 36;
const EMB_BYTES = 2048;

/**
 * One page of stored face embeddings for the backfill, as raw bytes: per face 36 ASCII id bytes then the
 * 2048 stored embedding bytes. No JSON, no base64, no per-float work: the Worker only copies bytes.
 * Keyset paging by rowid (no OFFSET); the next rowid comes back in X-Next-Cursor when the page was full.
 * D1: one query, at most `limit` (100) rows returned; rows scanned are the rowid range up to the page's last
 * match, so a sparse match set reads more rows than it returns (bounded by the faces table, rowid-ordered).
 */
export async function faceEmbeddingsRoute(c: Context<{ Bindings: Env }>) {
  const body = await readJson(c);
  if (body === undefined) return c.json({ error: 'Invalid JSON body' }, 400);
  const parsed = embeddingsSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: z.flattenError(parsed.error) }, 400);
  const { model, cursor = 0, limit = 100, rescore = false } = parsed.data;

  const { results } = await c.env.DB.prepare(
    `SELECT rowid AS cursor, id, embedding FROM faces
     WHERE embedding_model = ? AND rowid > ? AND (? = 1 OR known_id IS NULL)
     ORDER BY rowid LIMIT ?`
  )
    .bind(model, cursor, rescore ? 1 : 0, limit)
    .all<{ cursor: number; id: string; embedding: ArrayBuffer | null }>();

  const out = new Uint8Array(results.length * (ID_BYTES + EMB_BYTES));
  const enc = new TextEncoder();
  let n = 0;
  for (const r of results) {
    if (!r.embedding || r.id.length !== ID_BYTES) continue;
    const emb = new Uint8Array(r.embedding);
    if (emb.byteLength !== EMB_BYTES) continue;
    enc.encodeInto(r.id, out.subarray(n, n + ID_BYTES));
    out.set(emb, n + ID_BYTES);
    n += ID_BYTES + EMB_BYTES;
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
  if (results.length === limit) headers['X-Next-Cursor'] = String(results[results.length - 1].cursor);
  return new Response(out.subarray(0, n), { headers });
}

const knownSchema = z.object({
  matches: z
    .array(
      z.object({
        faceId: z.string().check(z.minLength(1), z.maxLength(64)),
        knownId: z.nullable(z.string().check(z.minLength(1), z.maxLength(64))),
        score: z.optional(z.number()),
      })
    )
    .check(z.minLength(1), z.maxLength(200)),
});

/**
 * Sets (or clears, with knownId null) known matches on up to 200 faces in one UPDATE ... FROM json_each.
 * A non-null knownId must exist in known_people, else 400 for the whole request and nothing changes.
 * D1: one indexed pre-check (<= 200 primary-key probes on known_people), then one UPDATE (<= 200 faces rows
 * read and written by primary key). Last write wins.
 */
export async function setFaceKnownRoute(c: Context<{ Bindings: Env }>) {
  const body = await readJson(c);
  if (body === undefined) return c.json({ error: 'Invalid JSON body' }, 400);
  const parsed = knownSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: z.flattenError(parsed.error) }, 400);
  const { matches } = parsed.data;

  const payload = JSON.stringify(
    matches.map((m) => ({ faceId: m.faceId, knownId: m.knownId, score: m.knownId === null ? null : (m.score ?? null) }))
  );
  const missing = await c.env.DB.prepare(
    `SELECT 1 AS x FROM json_each(?) j
     WHERE json_extract(j.value, '$.knownId') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM known_people k WHERE k.id = json_extract(j.value, '$.knownId'))
     LIMIT 1`
  )
    .bind(payload)
    .first();
  if (missing) return c.json({ error: 'Unknown knownId' }, 400);

  const res = await c.env.DB.prepare(
    `UPDATE faces SET known_id = j.known_id, known_score = j.score
     FROM (SELECT json_extract(value, '$.faceId') AS face_id, json_extract(value, '$.knownId') AS known_id,
                  json_extract(value, '$.score') AS score FROM json_each(?)) AS j
     WHERE faces.id = j.face_id`
  )
    .bind(payload)
    .run();
  return c.json({ updated: res.meta.changes });
}
