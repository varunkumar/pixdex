import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

const readHeaders = () => ({ Authorization: `Bearer ${env.READ_TOKEN}`, 'Content-Type': 'application/json' });
const PHOTO = '123e4567-e89b-12d3-a456-426614174000';

const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = readHeaders()) =>
  SELF.fetch(`https://example.com${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function addFace(id: string, x: number, det = 0.9, personId: string | null = null, status = 'unassigned', score: number | null = null) {
  await env.DB.prepare(
    `INSERT INTO faces (id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, det_score, embedding, embedding_model,
       person_id, assign_status, match_score, created_at)
     VALUES (?, ?, ?, 0.1, 0.2, 0.2, ?, zeroblob(2048), 'buffalo_l', ?, ?, ?, '2026-01-01')`
  )
    .bind(id, PHOTO, x, det, personId, status, score)
    .run();
}

const faceRow = (id: string) => env.DB.prepare('SELECT * FROM faces WHERE id = ?').bind(id).first<any>();

async function createPerson(name: string, faceIds?: string[]) {
  const res = await call('POST', '/people', { name, faceIds });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; name: string };
}

describe('people routes', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM face_rejections').run();
    await env.DB.prepare('DELETE FROM faces').run();
    await env.DB.prepare('DELETE FROM persons').run();
    await env.DB.prepare('DELETE FROM photos').run();
    const res = await SELF.fetch('https://example.com/ingest/photo', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.INGEST_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: PHOTO, contentHash: 'hash-people', source: 'local', filename: 'p.jpg', subjects: ['people'],
        tags: ['people'], description: 'd', modelProvider: 'ollama', modelName: 'qwen',
      }),
    });
    expect(res.status).toBe(201);
  });

  it('creates a person, trimming the name', async () => {
    const p = await createPerson('  Priya  ');
    expect(p.name).toBe('Priya');
    expect((await call('POST', '/people', { name: '   ' })).status).toBe(400);
    expect((await call('POST', '/people', { name: 'x'.repeat(61) })).status).toBe(400);
  });

  it('lists people with counts and the best confirmed face as cover', async () => {
    await addFace('f1', 0.1, 0.8);
    await addFace('f2', 0.3, 0.95);
    await addFace('f3', 0.5, 0.99);
    const a = await createPerson('Anu', ['f1', 'f2']);
    await createPerson('Bo');
    await env.DB.prepare("UPDATE faces SET person_id = ?, assign_status = 'auto', match_score = 0.5 WHERE id = 'f3'").bind(a.id).run();
    const body = (await (await call('GET', '/people')).json()) as any;
    expect(body.people.map((p: any) => p.name)).toEqual(['Anu', 'Bo']);
    expect(body.people[0]).toMatchObject({ id: a.id, faceCount: 3, photoCount: 1 });
    expect(body.people[0].cover.id).toBe('f2');
    expect(body.people[1]).toMatchObject({ faceCount: 0, photoCount: 0, cover: null });
    expect(JSON.stringify(body)).not.toContain('embedding');
  });

  it('rejects duplicate names case-insensitively', async () => {
    await createPerson('Priya');
    expect((await call('POST', '/people', { name: 'priya' })).status).toBe(409);
  });

  it('renames and rejects renaming to an existing name', async () => {
    const a = await createPerson('Anu');
    await createPerson('Bo');
    const ok = await call('PATCH', `/people/${a.id}`, { name: 'Anuradha' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ id: a.id, name: 'Anuradha' });
    expect((await call('PATCH', `/people/${a.id}`, { name: 'bo' })).status).toBe(409);
    expect((await call('PATCH', `/people/${a.id}`, { name: 'ANURADHA' })).status).toBe(200);
  });

  it('delete returns faces to unassigned and drops rejections', async () => {
    await addFace('f1', 0.1);
    await addFace('f2', 0.3);
    const a = await createPerson('Anu', ['f1']);
    await env.DB.prepare("UPDATE faces SET person_id = ?, assign_status = 'auto', match_score = 0.6 WHERE id = 'f2'").bind(a.id).run();
    await env.DB.prepare('INSERT INTO face_rejections (face_id, person_id) VALUES (?, ?)').bind('f2', a.id).run();
    const res = await call('DELETE', `/people/${a.id}`);
    expect(res.status).toBe(204);
    for (const id of ['f1', 'f2']) {
      expect(await faceRow(id)).toMatchObject({ person_id: null, match_score: null, assign_status: 'unassigned' });
    }
    const rej = await env.DB.prepare('SELECT COUNT(*) AS n FROM face_rejections').first<{ n: number }>();
    expect(rej?.n).toBe(0);
    expect(await env.DB.prepare('SELECT id FROM persons WHERE id = ?').bind(a.id).first()).toBeNull();
  });

  it('bulk assign confirms faces', async () => {
    await addFace('f1', 0.1, 0.9, null, 'unassigned');
    await addFace('f2', 0.3);
    const a = await createPerson('Anu');
    const res = await call('POST', `/people/${a.id}/faces`, { faceIds: ['f1', 'f2'] });
    expect(res.status).toBe(200);
    expect(await faceRow('f1')).toMatchObject({ person_id: a.id, assign_status: 'confirmed', match_score: null });
    expect(await faceRow('f2')).toMatchObject({ person_id: a.id, assign_status: 'confirmed' });
    expect((await call('POST', `/people/${a.id}/faces`, { faceIds: Array(201).fill('x') })).status).toBe(400);
  });

  it('bulk assign and create-with-faces 404 on unknown face ids and write nothing', async () => {
    await addFace('f1', 0.1);
    const a = await createPerson('Anu');
    const res = await call('POST', `/people/${a.id}/faces`, { faceIds: ['f1', 'ghost'] });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error).toContain('ghost');
    expect(await faceRow('f1')).toMatchObject({ person_id: null, assign_status: 'unassigned' });

    const created = await call('POST', '/people', { name: 'Bo', faceIds: ['f1', 'ghost2'] });
    expect(created.status).toBe(404);
    expect(((await created.json()) as any).error).toContain('ghost2');
    const bo = await env.DB.prepare("SELECT id FROM persons WHERE name = 'Bo'").first();
    expect(bo).toBeNull();
    expect(await faceRow('f1')).toMatchObject({ person_id: null });
  });

  it('assign overrides another person\'s confirmed face', async () => {
    const a = await createPerson('Anu');
    const b = await createPerson('Bo');
    await addFace('f1', 0.1, 0.9, a.id, 'confirmed');
    const res = await call('POST', '/faces/f1/assign', { personId: b.id });
    expect(await res.json()).toMatchObject({ personId: b.id, status: 'confirmed' });
  });

  it('assign overrides an auto assignment and clears the rejection', async () => {
    const a = await createPerson('Anu');
    const b = await createPerson('Bo');
    await addFace('f1', 0.1, 0.9, a.id, 'auto', 0.7);
    await env.DB.prepare('INSERT INTO face_rejections (face_id, person_id) VALUES (?, ?)').bind('f1', b.id).run();
    const res = await call('POST', '/faces/f1/assign', { personId: b.id });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ id: 'f1', personId: b.id, personName: 'Bo', status: 'confirmed', matchScore: null });
    expect(body.embedding).toBeUndefined();
    const rej = await env.DB.prepare('SELECT COUNT(*) AS n FROM face_rejections').first<{ n: number }>();
    expect(rej?.n).toBe(0);
  });

  it('reject removes an auto assignment and records the rejection', async () => {
    const a = await createPerson('Anu');
    await addFace('f1', 0.1, 0.9, a.id, 'auto', 0.7);
    const res = await call('POST', '/faces/f1/reject', { personId: a.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ personId: null, status: 'unassigned', matchScore: null });
    const rej = await env.DB.prepare('SELECT * FROM face_rejections').all<any>();
    expect(rej.results).toEqual([{ face_id: 'f1', person_id: a.id }]);
  });

  it('reject leaves an assignment to a different person alone', async () => {
    const a = await createPerson('Anu');
    const b = await createPerson('Bo');
    await addFace('f1', 0.1, 0.9, a.id, 'confirmed');
    const res = await call('POST', '/faces/f1/reject', { personId: b.id });
    expect(await res.json()).toMatchObject({ personId: a.id, status: 'confirmed' });
  });

  it('unassign returns the face to unassigned', async () => {
    const a = await createPerson('Anu');
    await addFace('f1', 0.1, 0.9, a.id, 'confirmed');
    const res = await call('POST', '/faces/f1/unassign');
    expect(await res.json()).toMatchObject({ personId: null, personName: null, status: 'unassigned', matchScore: null });
  });

  it('photo faces response never contains an embedding field', async () => {
    await addFace('f2', 0.6);
    await addFace('f1', 0.1);
    const res = await call('GET', `/photos/${PHOTO}/faces`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('embedding');
    expect(JSON.parse(text).faces.map((f: any) => f.id)).toEqual(['f1', 'f2']);
  });

  it('404 for an unknown face or person', async () => {
    const a = await createPerson('Anu');
    await addFace('f1', 0.1);
    expect((await call('POST', '/faces/nope/assign', { personId: a.id })).status).toBe(404);
    expect((await call('POST', '/faces/f1/assign', { personId: 'nope' })).status).toBe(404);
    expect((await call('POST', '/faces/nope/reject', { personId: a.id })).status).toBe(404);
    expect((await call('POST', '/faces/f1/reject', { personId: 'nope' })).status).toBe(404);
    expect((await call('POST', '/faces/nope/unassign')).status).toBe(404);
    expect((await call('PATCH', '/people/nope', { name: 'Z' })).status).toBe(404);
    expect((await call('DELETE', '/people/nope')).status).toBe(404);
    expect((await call('POST', '/people/nope/faces', { faceIds: ['f1'] })).status).toBe(404);
    expect((await call('GET', '/photos/nope/faces')).status).toBe(404);
  });

  it('401 without the read token', async () => {
    const none = {};
    expect((await call('GET', '/people', undefined, none)).status).toBe(401);
    expect((await call('POST', '/people', { name: 'A' }, none)).status).toBe(401);
    expect((await call('POST', '/faces/f1/unassign', undefined, none)).status).toBe(401);
    expect((await call('GET', `/photos/${PHOTO}/faces`, undefined, none)).status).toBe(401);
  });
});
