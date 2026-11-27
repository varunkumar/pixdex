import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { embeddingToBytes } from '../src/people/embedding';
import { OWNER_TEST_EMAIL, readHeaders } from './helpers';

const OWNER = OWNER_TEST_EMAIL;
const VIEWER = 'viewer@example.com';
const OTHER = 'other@example.com';

const run = (sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params).run();
const get = (path: string, as: string = OWNER) => SELF.fetch(`https://example.com${path}`, { headers: readHeaders(as) });
const faces = async (photos: string, as: string = OWNER, person = 'p1') => {
  const res = await get(`/people/${person}/faces?photos=${photos}`, as);
  expect(res.status).toBe(200);
  return (await res.json<{ faces: { id: string; personName: string | null }[] }>()).faces;
};
const ids = (list: { id: string }[]) => list.map((f) => f.id).sort();

const vector = new Float32Array(512);
vector[0] = 1;
const embedding = embeddingToBytes(vector).buffer;

const addFace = (id: string, photo: string, person: string | null, status = 'auto', ignored: string | null = null) =>
  run(
    `INSERT INTO faces (id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, det_score, embedding, embedding_model,
       person_id, assign_status, match_score, created_at, ignored_at)
     VALUES (?, ?, 0.1, 0.1, 0.2, 0.2, 0.9, ?, 'buffalo_l', ?, ?, 0.6, '2026-01-01T00:00:00.000Z', ?)`,
    id, photo, embedding, person, status, ignored
  );

const addPhoto = (id: string, album: string) =>
  run(
    `INSERT INTO photos (id, content_hash, source, filename, album, date_time, subjects, model_provider, model_name, last_indexed)
     VALUES (?, ?, 'local', 'a.jpg', ?, '2026-03-05T10:00:00', '[]', 'ollama', 'm', '2026-01-01T00:00:00.000Z')`,
    id, `hash-pf-${id}`, album
  );

const addPerson = (id: string, name: string) =>
  run("INSERT INTO persons (id, name, owner_email, created_at) VALUES (?, ?, ?, 'x')", id, name, OWNER);

beforeEach(async () => {
  for (const t of ['person_labels', 'face_rejections', 'faces', 'persons', 'photos']) await run(`DELETE FROM ${t}`);
  await addPhoto('ph1', 'Kanha');
  await addPhoto('ph2', 'Sundarbans');
  await addPhoto('ph3', 'Kanha');
  await run("UPDATE albums SET owner_email = ?, shared_with = ? WHERE name = 'Kanha'", OWNER, JSON.stringify([VIEWER]));
  await run("UPDATE albums SET owner_email = ?, shared_with = NULL WHERE name = 'Sundarbans'", OWNER);
  await addPerson('p1', 'Asha');
  await addPerson('p2', 'Bina');
  await addFace('confirmed', 'ph1', 'p1', 'confirmed');
  await addFace('auto', 'ph2', 'p1');
  await addFace('unnamed', 'ph1', null, 'unassigned');
  await addFace('ignored', 'ph1', null, 'unassigned', '2026-01-02T00:00:00.000Z');
  await addFace('someone-else', 'ph1', 'p2');
  await addFace('unasked', 'ph3', 'p1');
});

describe('GET /people/:id/faces', () => {
  it("returns the person's confirmed and auto faces on the asked photos, shaped like the photo's faces", async () => {
    const got = await faces('ph1,ph2');
    expect(ids(got)).toEqual(['auto', 'confirmed']);
    const onPhoto = await (await get('/photos/ph1/faces')).json<{ faces: { id: string }[] }>();
    expect(got.find((f) => f.id === 'confirmed')).toEqual(onPhoto.faces.find((f) => f.id === 'confirmed'));
  });

  it('leaves out photos the caller cannot see', async () => {
    expect(ids(await faces('ph1,ph2', VIEWER))).toEqual(['confirmed']);
    expect(await faces('ph1,ph2', OTHER)).toEqual([]);
  });

  it("gives a viewer their own label or null, never the owner's name", async () => {
    expect((await faces('ph1', VIEWER))[0].personName).toBeNull();
    await run("INSERT INTO person_labels VALUES (?, 'p1', 'Aunty', 'x')", VIEWER);
    expect((await faces('ph1', VIEWER))[0].personName).toBe('Aunty');
  });

  it('returns nothing for an unknown person or photo', async () => {
    expect(await faces('ph1', OWNER, 'nobody')).toEqual([]);
    expect(await faces('nothing')).toEqual([]);
  });

  it('checks the id list', async () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => `x${i}`).join(',');
    for (const path of ['/people/p1/faces', '/people/p1/faces?photos=', '/people/p1/faces?photos=,%20,', `/people/p1/faces?photos=${list(49)}`]) {
      expect((await get(path)).status, path).toBe(400);
    }
    expect((await get(`/people/p1/faces?photos=${list(48)},x0`)).status).toBe(200);
  });

  it('needs a viewer', async () => {
    const res = await SELF.fetch('https://example.com/people/p1/faces?photos=ph1', { headers: { Authorization: `Bearer ${env.READ_TOKEN}` } });
    expect(res.status).toBe(401);
  });
});
