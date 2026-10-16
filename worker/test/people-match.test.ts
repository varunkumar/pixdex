import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { embeddingToBytes } from '../src/people/embedding';

const readHeaders = () => ({ Authorization: `Bearer ${env.READ_TOKEN}`, 'Content-Type': 'application/json' });
const ingestHeaders = () => ({ Authorization: `Bearer ${env.INGEST_TOKEN}`, 'Content-Type': 'application/json' });
const HASH = 'hash-match';
const PHOTO = '123e4567-e89b-12d3-a456-426614174000';

const call = (method: string, path: string, body?: unknown) =>
  SELF.fetch(`https://example.com${path}`, {
    method,
    headers: readHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });

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

/** Ingest faces for the test photo through the real route. */
async function ingest(faces: { x: number; v: Float32Array; det?: number; w?: number }[]) {
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
}

const idAt = async (x: number) =>
  (await env.DB.prepare('SELECT id FROM faces WHERE photo_id = ? AND abs(bbox_x - ?) < 0.001').bind(PHOTO, x).first<{ id: string }>())!.id;
const row = (id: string) => env.DB.prepare('SELECT * FROM faces WHERE id = ?').bind(id).first<any>();

async function person(name: string, faceIds: string[] = []) {
  const res = await call('POST', '/people', { name, faceIds });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** A person whose single confirmed reference is e0 (placed at x=0.8). */
async function refPerson(name = 'Priya') {
  await ingest([{ x: 0.8, v: vec(1, 2) }]);
  return person(name, [await idAt(0.8)]);
}

describe('people groups and matching', () => {
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
  });

  it('groups clusters similar unassigned faces and ignores assigned ones', async () => {
    // Two near-identical faces (cluster), one far (single), one confirmed.
    await ingest([
      { x: 0.1, v: vec(1, 1) },
      { x: 0.2, v: vec(0.99, 1) },
      { x: 0.3, v: vec(0, 7) },
      { x: 0.4, v: vec(1, 1) },
    ]);
    await person('Ann', [await idAt(0.4)]);
    const res = await call('GET', '/people/groups');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.scanned).toBe(3);
    expect(body.nextCursor).toBeNull();
    expect(body.groups.map((g: any) => g.faces.length)).toEqual([2, 1]);
    const ids = body.groups.flatMap((g: any) => g.faces.map((f: any) => f.id));
    expect(ids).not.toContain(await idAt(0.4));
    expect(JSON.stringify(body)).not.toContain('embedding');
  });

  it('groups pages with a cursor', async () => {
    const stmts = [];
    for (let i = 0; i < 151; i++) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO faces (id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, det_score, embedding, embedding_model, created_at)
           VALUES (?, ?, 0.1, 0.1, 0.2, 0.2, 0.9, ?, 'buffalo_l', '2026-01-01')`
        ).bind(`f${i}`, PHOTO, embeddingToBytes(vec(1, 1)).buffer)
      );
    }
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    const first = (await (await call('GET', '/people/groups')).json()) as any;
    expect(first.scanned).toBe(150);
    expect(first.nextCursor).not.toBeNull();
    const second = (await (await call('GET', `/people/groups?cursor=${first.nextCursor}`)).json()) as any;
    expect(second.scanned).toBe(1);
    expect(second.nextCursor).toBeNull();
    expect(second.groups[0].faces[0].id).toBe('f150');
  });

  it('match returns auto and suggestion buckets by threshold', async () => {
    const pid = await refPerson();
    await ingest([
      { x: 0.1, v: vec(0.6) },
      { x: 0.2, v: vec(0.45) },
      { x: 0.3, v: vec(0.2) },
    ]);
    const res = await call('POST', `/people/${pid}/match`, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.scanned).toBe(3);
    expect(body.auto.map((f: any) => f.id)).toEqual([await idAt(0.1)]);
    expect(body.suggestions.map((f: any) => f.id)).toEqual([await idAt(0.2)]);
    expect(body.auto[0].matchScore).toBeCloseTo(0.6, 3);
    expect(JSON.stringify(body)).not.toContain('embedding');
  });

  it('match without apply writes nothing', async () => {
    const pid = await refPerson();
    await ingest([{ x: 0.1, v: vec(0.6) }]);
    await call('POST', `/people/${pid}/match`, { apply: false });
    const r = await row(await idAt(0.1));
    expect(r.assign_status).toBe('unassigned');
    expect(r.person_id).toBeNull();
  });

  it('match with apply saves only auto matches and never suggestions', async () => {
    const pid = await refPerson();
    await ingest([{ x: 0.1, v: vec(0.6) }, { x: 0.2, v: vec(0.45) }]);
    const body = (await (await call('POST', `/people/${pid}/match`, { apply: true })).json()) as any;
    expect(body.auto[0].status).toBe('auto');
    const a = await row(await idAt(0.1));
    expect(a).toMatchObject({ assign_status: 'auto', person_id: pid });
    expect(a.match_score).toBeCloseTo(0.6, 3);
    const s = await row(await idAt(0.2));
    expect(s).toMatchObject({ assign_status: 'unassigned', person_id: null, match_score: null });
  });

  it('match never overwrites a confirmed face', async () => {
    const pid = await refPerson();
    await ingest([{ x: 0.1, v: vec(0.9) }]);
    const other = await person('Other', [await idAt(0.1)]);
    const body = (await (await call('POST', `/people/${pid}/match`, { apply: true })).json()) as any;
    expect(body.auto).toEqual([]);
    expect(await row(await idAt(0.1))).toMatchObject({ assign_status: 'confirmed', person_id: other });
  });

  it('match skips a face rejected for this person, including after re-ingest', async () => {
    const pid = await refPerson();
    await ingest([{ x: 0.1, v: vec(0.9) }]);
    expect(((await (await call('POST', `/people/${pid}/match`, {})).json()) as any).auto).toHaveLength(1);
    const res = await call('POST', `/faces/${await idAt(0.1)}/reject`, { personId: pid });
    expect(res.status).toBe(200);
    expect(((await (await call('POST', `/people/${pid}/match`, {})).json()) as any).auto).toHaveLength(0);

    // Re-ingest the same photo: the face gets a new id but must stay rejected.
    await ingest([{ x: 0.1, v: vec(0.9) }, { x: 0.8, v: vec(1, 2) }]);
    const body = (await (await call('POST', `/people/${pid}/match`, {})).json()) as any;
    expect(body.auto).toEqual([]);
    expect(body.suggestions).toEqual([]);
  });

  it('match takes an auto face from another person only on a higher score', async () => {
    const pid = await refPerson('Priya');
    await ingest([{ x: 0.1, v: vec(0.6) }, { x: 0.2, v: vec(0.7) }]);
    const other = await person('Other');
    const lowId = await idAt(0.1);
    const highId = await idAt(0.2);
    await env.DB.prepare("UPDATE faces SET person_id = ?, assign_status = 'auto', match_score = 0.65 WHERE id = ?").bind(other, lowId).run();
    await env.DB.prepare("UPDATE faces SET person_id = ?, assign_status = 'auto', match_score = 0.65 WHERE id = ?").bind(other, highId).run();
    const body = (await (await call('POST', `/people/${pid}/match`, { apply: true })).json()) as any;
    expect(body.auto.map((f: any) => f.id)).toEqual([highId]);
    expect(await row(lowId)).toMatchObject({ person_id: other, match_score: 0.65 });
    expect(await row(highId)).toMatchObject({ person_id: pid, assign_status: 'auto' });
  });

  it('match for a person with no confirmed faces returns empty lists', async () => {
    const pid = await person('Nobody');
    await ingest([{ x: 0.1, v: vec(0.9) }]);
    const res = await call('POST', `/people/${pid}/match`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ auto: [], suggestions: [], nextCursor: null });
  });

  it('match with nothing unassigned returns empty lists', async () => {
    const pid = await refPerson();
    const res = await call('POST', `/people/${pid}/match`, { apply: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ auto: [], suggestions: [], scanned: 0, nextCursor: null });
  });

  it('match returns 404 for an unknown person', async () => {
    expect((await call('POST', '/people/nope/match', {})).status).toBe(404);
  });

  it('groups and match skip a face below the quality rule but the photo page still lists it', async () => {
    const pid = await refPerson();
    await ingest([
      { x: 0.1, v: vec(0.9), det: 0.3 },
      { x: 0.3, v: vec(0.9), w: 0.01 },
    ]);
    const groups = (await (await call('GET', '/people/groups')).json()) as any;
    expect(groups.scanned).toBe(0);
    const match = (await (await call('POST', `/people/${pid}/match`, {})).json()) as any;
    expect(match.scanned).toBe(0);
    expect(match.auto).toEqual([]);
    const photo = (await (await call('GET', `/photos/${PHOTO}/faces`)).json()) as any;
    expect(photo.faces).toHaveLength(3);
  });

  it('match uses the best score over several references', async () => {
    // Adult reference e0, child reference e2; candidate close to e2 only.
    await ingest([{ x: 0.7, v: vec(1, 2) }, { x: 0.8, v: vec(0, 3) }]);
    const pid = await person('Kid', [await idAt(0.7), await idAt(0.8)]);
    // Re-ingest keeps the confirmed references; the candidate is 0.8 to the second one only.
    await ingest([{ x: 0.7, v: vec(1, 2) }, { x: 0.8, v: vec(0, 3) }, { x: 0.2, v: (() => { const v = new Float32Array(512); v[3] = 0.8; v[9] = 0.6; return v; })() }]);
    const body = (await (await call('POST', `/people/${pid}/match`, {})).json()) as any;
    expect(body.auto.map((f: any) => f.id)).toEqual([await idAt(0.2)]);
    expect(body.auto[0].matchScore).toBeCloseTo(0.8, 3);
  });

  it('matches 300 candidates quickly', async () => {
    const pid = await refPerson();
    const stmts = [];
    for (let i = 0; i < 300; i++) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO faces (id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, det_score, embedding, embedding_model, created_at)
           VALUES (?, ?, 0.1, 0.1, 0.2, 0.2, 0.9, ?, 'buffalo_l', '2026-01-01')`
        ).bind(`c${i}`, PHOTO, embeddingToBytes(vec(0.3 + (i % 50) * 0.01, 1 + (i % 400))).buffer)
      );
    }
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    const t = performance.now();
    const res = await call('POST', `/people/${pid}/match`, {});
    const ms = performance.now() - t;
    console.log(`MATCH_300_MS ${ms.toFixed(0)}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).scanned).toBe(300);
    expect(ms).toBeLessThan(5000);
  });
});
