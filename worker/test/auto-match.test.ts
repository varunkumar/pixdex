import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { embeddingToBytes } from '../src/people/embedding';
import { autoMatchFaces } from '../src/people/autoMatch';

const ingestHeaders = () => ({ Authorization: `Bearer ${env.INGEST_TOKEN}`, 'Content-Type': 'application/json' });
const HASH = 'hash-auto';
const PHOTO = '223e4567-e89b-12d3-a456-426614174000';

/** Unit vector whose dot with unit axis e0 is `c`, in the e0/e`axis` plane. */
function vec(c: number, axis = 1): Float32Array {
  const v = new Float32Array(512);
  v[0] = c;
  v[axis] = Math.sqrt(1 - c * c);
  return v;
}
const b64 = (v: Float32Array) => {
  let s = '';
  for (const b of embeddingToBytes(v)) s += String.fromCharCode(b);
  return btoa(s);
};

type F = { x: number; v: Float32Array; det?: number; w?: number };
async function ingest(faces: F[]) {
  const res = await SELF.fetch('https://example.com/ingest/faces', {
    method: 'POST',
    headers: ingestHeaders(),
    body: JSON.stringify({
      contentHash: HASH,
      model: 'buffalo_l',
      faces: faces.map((f) => ({
        bbox: { x: f.x, y: 0.1, w: f.w ?? 0.2, h: f.w ?? 0.2 },
        detScore: f.det ?? 0.9,
        embedding: b64(f.v),
      })),
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { stored: number; kept: number; matched: number; skipped: number };
}
const rowAt = (x: number) =>
  env.DB.prepare('SELECT * FROM faces WHERE photo_id = ? AND abs(bbox_x - ?) < 0.001').bind(PHOTO, x).first<any>();

async function addPerson(id: string, name: string) {
  await env.DB.prepare('INSERT INTO persons (id, name, created_at) VALUES (?, ?, ?)').bind(id, name, 't').run();
}
/** Confirmed reference face on a second photo-less id (photo_id is not constrained). */
async function addConfirmed(personId: string, v: Float32Array, createdAt: string) {
  await env.DB.prepare(
    `INSERT INTO faces (id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, det_score, embedding, embedding_model,
       person_id, assign_status, match_score, created_at)
     VALUES (?, 'other', 0.5, 0.5, 0.2, 0.2, 0.9, ?, 'buffalo_l', ?, 'confirmed', NULL, ?)`
  ).bind(crypto.randomUUID(), embeddingToBytes(v).buffer, personId, createdAt).run();
}

describe('automatic matching at ingest', () => {
  beforeEach(async () => {
    for (const t of ['face_rejections', 'faces', 'persons', 'photos']) await env.DB.prepare(`DELETE FROM ${t}`).run();
    const res = await SELF.fetch('https://example.com/ingest/photo', {
      method: 'POST',
      headers: ingestHeaders(),
      body: JSON.stringify({
        id: PHOTO, contentHash: HASH, source: 'local', filename: 'p.jpg', subjects: ['people'],
        tags: ['people'], description: 'd', modelProvider: 'ollama', modelName: 'qwen',
      }),
    });
    expect(res.status).toBe(201);
    await addPerson('p1', 'Priya');
    await addConfirmed('p1', vec(1, 2), '2026-01-01');
  });

  it('a new face close to a named person is saved as auto with its score', async () => {
    const r = await ingest([{ x: 0.1, v: vec(0.9) }]);
    expect(r.matched).toBe(1);
    const f = await rowAt(0.1);
    expect(f.assign_status).toBe('auto');
    expect(f.person_id).toBe('p1');
    expect(f.match_score).toBeCloseTo(0.9, 3);
  });

  it('a new face below the threshold stays unassigned', async () => {
    const r = await ingest([{ x: 0.1, v: vec(0.3) }]);
    expect(r.matched).toBe(0);
    const f = await rowAt(0.1);
    expect(f.assign_status).toBe('unassigned');
    expect(f.person_id).toBeNull();
  });

  it('a tiny or low-score face is stored but never auto-matched', async () => {
    const r = await ingest([
      { x: 0.1, v: vec(0.95), det: 0.3 },
      { x: 0.5, v: vec(0.95), w: 0.01 },
    ]);
    expect(r).toEqual({ stored: 2, kept: 0, matched: 0, skipped: 0 });
    expect((await rowAt(0.1)).assign_status).toBe('unassigned');
    expect((await rowAt(0.5)).assign_status).toBe('unassigned');
  });

  it('the best of several persons wins', async () => {
    await addPerson('p2', 'Ravi');
    await addConfirmed('p2', vec(0.8, 3), '2026-01-01');
    await ingest([{ x: 0.1, v: vec(0.9) }]);
    expect((await rowAt(0.1)).person_id).toBe('p1');
  });

  it('a rejected pair is not re-attached after re-ingest', async () => {
    await ingest([{ x: 0.1, v: vec(0.9) }]);
    const first = await rowAt(0.1);
    expect(first.assign_status).toBe('auto');
    await env.DB.prepare('INSERT INTO face_rejections (face_id, person_id) VALUES (?, ?)').bind(first.id, 'p1').run();
    const r = await ingest([{ x: 0.1, v: vec(0.9) }]);
    expect(r.matched).toBe(0);
    const again = await rowAt(0.1);
    expect(again.assign_status).toBe('unassigned');
    expect(again.person_id).toBeNull();
  });

  it('a confirmed face is untouched when the photo is re-ingested', async () => {
    await ingest([{ x: 0.1, v: vec(0.9) }]);
    const f = await rowAt(0.1);
    await env.DB.prepare("UPDATE faces SET assign_status = 'confirmed' WHERE id = ?").bind(f.id).run();
    const r = await ingest([{ x: 0.1, v: vec(0.9) }, { x: 0.6, v: vec(0.9) }]);
    expect(r.kept).toBe(1);
    expect(r.matched).toBe(1);
    const after = await rowAt(0.1);
    expect(after.id).toBe(f.id);
    expect(after.assign_status).toBe('confirmed');
    expect(after.match_score).toBe(f.match_score);
  });

  it('a photo with no faces loads no references', async () => {
    const queries: string[] = [];
    const spy = {
      prepare(sql: string) {
        queries.push(sql);
        return env.DB.prepare(sql);
      },
    } as unknown as D1Database;
    expect(await autoMatchFaces(spy, [])).toEqual({ matched: 0, skipped: 0 });
    expect(queries.filter((q) => q.includes('confirmed'))).toEqual([]);
    expect(queries).toEqual([]);
    expect(await ingest([])).toEqual({ stored: 0, kept: 0, matched: 0, skipped: 0 });
  });

  it('only the newest 30 confirmed faces per person are used', async () => {
    await env.DB.prepare('DELETE FROM faces').run();
    await addConfirmed('p1', vec(1, 2), '2020-01-01'); // oldest, the only close one
    for (let i = 0; i < 30; i++) await addConfirmed('p1', vec(0, 5), `2026-02-${String(i + 1).padStart(2, '0')}`);
    const r = await ingest([{ x: 0.1, v: vec(0.9) }]);
    expect(r.matched).toBe(0);
    expect((await rowAt(0.1)).assign_status).toBe('unassigned');
  });

  it('ingest response includes matched', async () => {
    expect(await ingest([{ x: 0.1, v: vec(0.9) }, { x: 0.5, v: vec(0.2) }])).toEqual({ stored: 2, kept: 0, matched: 1, skipped: 0 });
  });

  it('skips matchable faces beyond the work budget and reports them', async () => {
    // 1 person x 1 reference: budget is floor(1.5M / 512) = 2929 faces; use many refs to shrink it.
    for (let i = 0; i < 29; i++) await addConfirmed('p1', vec(1, 2 + i), `2026-01-${String(i + 2).padStart(2, '0')}`);
    // 30 refs -> 15360 MACs per face -> 97 faces within MAX_AUTO_MATCH_MACS.
    const ids: string[] = [];
    const stmts = [];
    for (let i = 0; i < 100; i++) {
      const id = `bulk${i}`;
      ids.push(id);
      stmts.push(
        env.DB.prepare(
          `INSERT INTO faces (id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, det_score, embedding, embedding_model, created_at)
           VALUES (?, ?, 0.1, 0.1, 0.2, 0.2, 0.9, ?, 'buffalo_l', '2026-02-01')`
        ).bind(id, PHOTO, embeddingToBytes(vec(1, 2)).buffer)
      );
    }
    await env.DB.batch(stmts);
    expect(await autoMatchFaces(env.DB, ids)).toEqual({ matched: 97, skipped: 3 });
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM faces WHERE id LIKE 'bulk%' AND assign_status = 'unassigned'").first<{ n: number }>();
    expect(left?.n).toBe(3);
  });
});
