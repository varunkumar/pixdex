import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { OWNER_TEST_EMAIL, readHeaders } from './helpers';

const OWNER = OWNER_TEST_EMAIL;
const VIEWER = 'viewer@example.com';
const STRANGER = 'stranger@example.com';

const run = (sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params).run();
const get = (album: string, as: string = OWNER) =>
  SELF.fetch(`https://example.com/albums/contents?name=${encodeURIComponent(album)}`, { headers: readHeaders(as) });

async function insertPhoto(id: string, album: string, species = '[]') {
  await run(
    `INSERT INTO photos (id, content_hash, source, filename, album, date_time, model_provider, model_name, last_indexed, species)
     VALUES (?, ?, 'local', 'a.jpg', ?, '2026-03-05T10:00:00', 'ollama', 'm', '2026-01-01T00:00:00.000Z', ?)`,
    id,
    `hash-${id}-0123456789`,
    album,
    species
  );
}

async function insertFace(
  id: string,
  photoId: string,
  opts: { person?: string | null; status?: string; det?: number; known?: string | null; knownScore?: number } = {}
) {
  const person = opts.person ?? null;
  await run(
    `INSERT INTO faces (id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, det_score, embedding, embedding_model, crop_key, person_id, assign_status, known_id, known_score, created_at)
     VALUES (?, ?, 0, 0, 1, 1, ?, x'00', 'm', NULL, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
    id,
    photoId,
    opts.det ?? 0.9,
    person,
    opts.status ?? (person ? 'confirmed' : 'unassigned'),
    opts.known ?? null,
    opts.known ? (opts.knownScore ?? 0.9) : null
  );
}

const sp = (common: string, scientific: string, score: number) => ({ common, scientific, score });

describe('GET /albums/contents', () => {
  beforeEach(async () => {
    await run('DELETE FROM person_labels');
    await run('DELETE FROM faces');
    await run('DELETE FROM persons');
    await run('DELETE FROM photos');
    await run('DELETE FROM known_people');
    await insertPhoto('a1', 'Kanha', JSON.stringify([sp('Tiger', 'Panthera tigris', 0.7), sp('Chital', 'Axis axis', 0.6)]));
    await insertPhoto('a2', 'Kanha', JSON.stringify([sp('Bengal tiger', 'Panthera tigris', 0.95)]));
    await insertPhoto('a3', 'Kanha');
    await insertPhoto('r1', 'Ranthambore');
    await run(`UPDATE albums SET shared_with = '["viewer@example.com"]' WHERE name = 'Kanha'`);
    await run("UPDATE albums SET owner_email = 'other@example.com' WHERE name = 'Ranthambore'");
    await run(
      `INSERT INTO persons (id, name, owner_email, created_at) VALUES ('p1', 'SecretMina', 'owner@example.com', 'x'), ('p2', 'Zed', 'owner@example.com', 'x')`
    );
    await run(`INSERT INTO known_people (id, name, aliases, created_at) VALUES ('Q1', 'Alpha', '[]', 'x'), ('Q2', 'Beta', '[]', 'x')`);
  });

  it('counts distinct photos per person and ignores rejected and unassigned faces', async () => {
    await insertFace('f1', 'a1', { person: 'p1' });
    await insertFace('f2', 'a1', { person: 'p1' }); // same person twice in one photo
    await insertFace('f3', 'a2', { person: 'p1', status: 'auto', det: 0.99 });
    await insertFace('f4', 'a3', { person: 'p2' });
    await insertFace('f5', 'a3'); // unassigned
    await insertFace('f6', 'a2', { person: 'p2', status: 'unassigned' }); // not auto or confirmed
    await insertFace('f7', 'r1', { person: 'p1' }); // other album
    const body = await (await get('Kanha')).json<any>();
    expect(body.people.map((p: any) => [p.id, p.name, p.canEdit, p.photoCount])).toEqual([
      ['p1', 'SecretMina', true, 2],
      ['p2', 'Zed', true, 1],
    ]);
    expect(body.people[0].cover.id).toBe('f1'); // confirmed beats auto even with a lower det_score
    expect(body.people[0].cover.thumbnailUrl).toBe('/thumbnails/hash-a1-0123456789');
  });

  it('person cover is cover_face_id when in the album, else best confirmed, else auto', async () => {
    await insertFace('c1', 'a1', { person: 'p1', det: 0.5 });
    await insertFace('c2', 'a2', { person: 'p1', det: 0.8 });
    await insertFace('c3', 'r1', { person: 'p1', det: 0.99 });
    expect((await (await get('Kanha')).json<any>()).people[0].cover.id).toBe('c2');
    await run("UPDATE persons SET cover_face_id = 'c1' WHERE id = 'p1'");
    expect((await (await get('Kanha')).json<any>()).people[0].cover.id).toBe('c1');
    await run("UPDATE persons SET cover_face_id = 'c3' WHERE id = 'p1'"); // not in this album
    expect((await (await get('Kanha')).json<any>()).people[0].cover.id).toBe('c2');
    await run("UPDATE faces SET assign_status = 'auto' WHERE id IN ('c1', 'c2')");
    await run("UPDATE persons SET cover_face_id = NULL WHERE id = 'p1'");
    await insertFace('c4', 'a3', { person: 'p1', det: 0.1 }); // confirmed again, wins over auto
    expect((await (await get('Kanha')).json<any>()).people[0].cover.id).toBe('c4');
  });

  it('known tiles count faces with a known_id whether or not a person is set', async () => {
    await insertFace('k1', 'a1', { known: 'Q1', knownScore: 0.7 });
    await insertFace('k2', 'a2', { known: 'Q1', person: 'p1', knownScore: 0.95 });
    await insertFace('k3', 'a2', { known: 'Q1' }); // same photo again
    await insertFace('k4', 'a3', { known: 'Q2' });
    await insertFace('k5', 'r1', { known: 'Q2' });
    const body = await (await get('Kanha')).json<any>();
    expect(body.known.map((k: any) => [k.id, k.name, k.photoCount])).toEqual([
      ['Q1', 'Alpha', 2],
      ['Q2', 'Beta', 1],
    ]);
    expect(body.known[0].cover.id).toBe('k2');
  });

  it('groups species by scientific name with the best-scoring photo as cover', async () => {
    const body = await (await get('Kanha')).json<any>();
    expect(body.species).toEqual([
      { scientific: 'Panthera tigris', common: 'Bengal tiger', photoCount: 2, coverPhotoId: 'a2', thumbnailUrl: '/thumbnails/hash-a2-0123456789' },
      { scientific: 'Axis axis', common: 'Chital', photoCount: 1, coverPhotoId: 'a1', thumbnailUrl: '/thumbnails/hash-a1-0123456789' },
    ]);
  });

  it('ignores malformed species JSON', async () => {
    await run("UPDATE photos SET species = 'not json' WHERE id = 'a3'");
    await run(`UPDATE photos SET species = '{"scientific":"x"}' WHERE id = 'a1'`);
    const res = await get('Kanha');
    expect(res.status).toBe(200);
    expect((await res.json<any>()).species.map((s: any) => s.scientific)).toEqual(['Panthera tigris']);
  });

  it('a viewer sees the owner person under their own label or null, never the raw name', async () => {
    await insertFace('v1', 'a1', { person: 'p1' });
    const none = await get('Kanha', VIEWER);
    const text = await none.text();
    expect(text).not.toContain('SecretMina');
    const body = JSON.parse(text);
    expect(body.people[0]).toMatchObject({ id: 'p1', name: null, canEdit: false, photoCount: 1 });
    expect(body.people[0].cover.personName).toBeNull();
    await run("INSERT INTO person_labels (viewer_email, person_id, name, created_at) VALUES (?, 'p1', 'My Label', 'x')", VIEWER);
    const labelled = await (await get('Kanha', VIEWER)).text();
    expect(labelled).not.toContain('SecretMina');
    const lb = JSON.parse(labelled);
    expect(lb.people[0].name).toBe('My Label');
    expect(lb.people[0].cover.personName).toBe('My Label');
  });

  it('is 404 for a private album and for a stranger, 400 without a name', async () => {
    expect((await get('Ranthambore', OWNER)).status).toBe(404);
    expect((await get('Kanha', STRANGER)).status).toBe(404);
    expect((await get('Nope')).status).toBe(404);
    const res = await SELF.fetch('https://example.com/albums/contents', { headers: readHeaders() });
    expect(res.status).toBe(400);
  });

  it('an empty album gives three empty lists', async () => {
    await run("DELETE FROM photos WHERE album = 'Kanha'");
    await insertPhoto('e1', 'Kanha');
    expect(await (await get('Kanha')).json()).toEqual({ people: [], known: [], species: [] });
  });

  it('caps each list at 200', async () => {
    const list = Array.from({ length: 250 }, (_, i) => sp(`c${i}`, `Genus sp${String(i).padStart(3, '0')}`, 0.9));
    await run('UPDATE photos SET species = ? WHERE id = ?', JSON.stringify(list), 'a3');
    const body = await (await get('Kanha')).json<any>();
    expect(body.species).toHaveLength(200);
  });

  it('requires the read token and the viewer email', async () => {
    const url = 'https://example.com/albums/contents?name=Kanha';
    expect((await SELF.fetch(url)).status).toBe(401);
    expect((await SELF.fetch(url, { headers: { Authorization: readHeaders().Authorization } })).status).toBe(401);
  });
});
