import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { OWNER_TEST_EMAIL, readHeaders } from './helpers';

const OWNER = OWNER_TEST_EMAIL;
const VIEWER = 'viewer@example.com';
const STRANGER = 'stranger@example.com';

const run = (sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params).run();
const get = (as: string) => SELF.fetch('https://example.com/people/known', { headers: readHeaders(as) });
const pairs = async (as: string) => (await (await get(as)).json<any>()).known.map((k: any) => [k.id, k.photoCount]);

async function insertPhoto(id: string, album: string) {
  await run(
    `INSERT INTO photos (id, content_hash, source, filename, album, date_time, aesthetic_score, subjects, model_provider, model_name, last_indexed)
     VALUES (?, ?, 'local', 'a.jpg', ?, '2026-03-05T10:00:00', 8, '["x"]', 'ollama', 'm', '2026-01-01T00:00:00.000Z')`,
    id,
    `hash-${id}-0123456789`,
    album
  );
}

async function insertFace(id: string, photoId: string, knownId: string | null, personId: string | null = null) {
  await run(
    `INSERT INTO faces (id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, det_score, embedding, embedding_model, crop_key, person_id, assign_status, known_id, known_score, created_at)
     VALUES (?, ?, 0, 0, 1, 1, 0.9, x'00', 'm', NULL, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
    id,
    photoId,
    personId,
    personId ? 'confirmed' : 'unassigned',
    knownId,
    knownId ? 0.9 : null
  );
}

describe('GET /people/known', () => {
  beforeEach(async () => {
    await run('DELETE FROM faces');
    await run('DELETE FROM persons');
    await run('DELETE FROM photos');
    await run('DELETE FROM known_people');
    await insertPhoto('k1', 'Kanha');
    await insertPhoto('k2', 'Kanha');
    await insertPhoto('r1', 'Ranthambore');
    await run(`UPDATE albums SET shared_with = '["viewer@example.com"]' WHERE name = 'Kanha'`);
    await run("UPDATE albums SET owner_email = 'other@example.com' WHERE name = 'Ranthambore'");
    await run(
      `INSERT INTO known_people (id, name, aliases, created_at) VALUES ('Q1', 'Alpha', '["A"]', 'x'), ('Q2', 'Beta', '[]', 'x'), ('Q3', 'Gamma', '[]', 'x'), ('Q4', 'Unmatched', '[]', 'x')`
    );
    await run("INSERT INTO persons (id, name, owner_email, created_at) VALUES ('p1', 'Mine', 'owner@example.com', 'x')");
    await insertFace('fa1', 'k1', 'Q1');
    await insertFace('fa2', 'k2', 'Q1', 'p1');
    await insertFace('fa3', 'k2', 'Q1'); // second face of Q1 in k2: counts once
    await insertFace('fb1', 'k1', 'Q2');
    await insertFace('fa4', 'r1', 'Q1'); // hidden album
    await insertFace('fc1', 'r1', 'Q3'); // only in hidden album
    await insertFace('fn', 'k1', null);
  });

  it('owner sees distinct photo counts, including faces that also have a person_id', async () => {
    const res = await get(OWNER);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      known: [
        { id: 'Q1', name: 'Alpha', aliases: ['A'], photoCount: 2 },
        { id: 'Q2', name: 'Beta', aliases: [], photoCount: 1 },
      ],
    });
  });

  it('a viewer of a shared album sees counts for that album only', async () => {
    expect(await pairs(VIEWER)).toEqual([['Q1', 2], ['Q2', 1]]);
    await run(`UPDATE albums SET shared_with = '["viewer@example.com"]' WHERE name = 'Ranthambore'`);
    expect(await pairs(VIEWER)).toEqual([['Q1', 3], ['Q2', 1], ['Q3', 1]]);
  });

  it('a user with no access gets an empty list and no names', async () => {
    const res = await get(STRANGER);
    expect(await res.text()).toBe('{"known":[]}');
  });

  it('a known person with zero visible photos is absent and unmatched people are not listed', async () => {
    const ids = (await pairs(OWNER)).map((p: any) => p[0]);
    expect(ids).not.toContain('Q3');
    expect(ids).not.toContain('Q4');
  });

  it('sorts by photoCount desc then name', async () => {
    await insertFace('fb2', 'k2', 'Q2');
    expect((await pairs(OWNER)).map((p: any) => p[0])).toEqual(['Q1', 'Q2']);
    await run("UPDATE known_people SET name = 'Aaa' WHERE id = 'Q2'");
    expect((await pairs(OWNER)).map((p: any) => p[0])).toEqual(['Q2', 'Q1']);
  });

  it('returns 401 without X-Viewer-Email', async () => {
    const res = await SELF.fetch('https://example.com/people/known', { headers: { Authorization: `Bearer ${env.READ_TOKEN}` } });
    expect(res.status).toBe(401);
  });
});
