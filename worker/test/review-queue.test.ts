import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { embeddingToBytes } from '../src/people/embedding';
import { OWNER_TEST_EMAIL, readHeaders } from './helpers';

const OWNER = OWNER_TEST_EMAIL;
const VIEWER = 'viewer@example.com';
const OTHER = 'other@example.com';

const run = (sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params).run();
const queue = async (as: string = OWNER) => {
  const res = await SELF.fetch('https://example.com/people/review-queue', { headers: readHeaders(as) });
  expect(res.status).toBe(200);
  return res.json<{ people: { id: string; count: number }[] }>();
};

const vector = new Float32Array(512);
vector[0] = 1;
const embedding = embeddingToBytes(vector).buffer;

let next = 0;
async function addFaces(n: number, person: string | null, status = 'auto', photo = 'ph1') {
  for (let i = 0; i < n; i++) {
    await run(
      `INSERT INTO faces (id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, det_score, embedding, embedding_model,
         person_id, assign_status, match_score, created_at)
       VALUES (?, ?, 0.1, 0.1, 0.2, 0.2, 0.9, ?, 'buffalo_l', ?, ?, 0.6, '2026-01-01T00:00:00.000Z')`,
      `q${next++}`, photo, embedding, person, status
    );
  }
}

async function addPhoto(id: string, album: string) {
  await run(
    `INSERT INTO photos (id, content_hash, source, filename, album, date_time, subjects, model_provider, model_name, last_indexed)
     VALUES (?, ?, 'local', 'a.jpg', ?, '2026-03-05T10:00:00', '[]', 'ollama', 'm', '2026-01-01T00:00:00.000Z')`,
    id, `hash-queue-${id}`, album
  );
}

const addPerson = (id: string, name: string, owner: string = OWNER) =>
  run("INSERT INTO persons (id, name, owner_email, created_at) VALUES (?, ?, ?, 'x')", id, name, owner);

beforeEach(async () => {
  for (const t of ['face_rejections', 'faces', 'persons', 'photos']) await run(`DELETE FROM ${t}`);
  await addPhoto('ph1', 'Kanha');
  await addPhoto('ph2', 'Sundarbans');
  await run("UPDATE albums SET owner_email = ?, shared_with = ? WHERE name = 'Kanha'", OWNER, JSON.stringify([VIEWER]));
  await run("UPDATE albums SET owner_email = ?, shared_with = ? WHERE name = 'Sundarbans'", OTHER, JSON.stringify([OWNER]));
});

describe('GET /people/review-queue', () => {
  it('counts auto faces per person, most first, ties by name', async () => {
    await addPerson('p1', 'zara');
    await addPerson('p2', 'Asha');
    await addPerson('p3', 'Ravi');
    await addPerson('p4', 'Nobody pending');
    await addFaces(1, 'p1');
    await addFaces(1, 'p2');
    await addFaces(3, 'p3');
    await addFaces(2, 'p4', 'confirmed');
    await addFaces(2, null, 'unassigned');
    expect(await queue()).toEqual({ people: [{ id: 'p3', count: 3 }, { id: 'p2', count: 1 }, { id: 'p1', count: 1 }] });
  });

  it("counts only the caller's people in the caller's albums", async () => {
    await addPerson('mine', 'Asha');
    await addPerson('theirs', 'Bina', OTHER);
    await addFaces(2, 'mine');
    await addFaces(4, 'mine', 'auto', 'ph2');
    await addFaces(3, 'theirs');
    expect(await queue()).toEqual({ people: [{ id: 'mine', count: 2 }] });
    expect(await queue(OTHER)).toEqual({ people: [] });
    expect(await queue(VIEWER)).toEqual({ people: [] });
  });

  it('needs a viewer', async () => {
    const res = await SELF.fetch('https://example.com/people/review-queue', { headers: { Authorization: `Bearer ${env.READ_TOKEN}` } });
    expect(res.status).toBe(401);
  });
});
