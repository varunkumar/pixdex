import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/index';
import { guardedWrites } from '../src/access';
import { OWNER_TEST_EMAIL, readHeaders, restoreAlbumOwnerFixture, withoutAlbumOwnerFixture } from './helpers';

const OWNER = OWNER_TEST_EMAIL;
const VIEWER = 'viewer@example.com';
const STRANGER = 'stranger@example.com';
const OTHER = 'other@example.com';

const run = (sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params).run();
const send = (method: string, path: string, as: string, body?: unknown) =>
  SELF.fetch(`https://example.com${path}`, {
    method,
    headers: { ...readHeaders(as), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const sharedWith = async (album: string) => (await env.DB.prepare('SELECT shared_with FROM albums WHERE name = ?').bind(album).first<{ shared_with: string | null }>())?.shared_with;

async function insertPhoto(id: string, album: string | null) {
  await run(
    `INSERT INTO photos (id, content_hash, source, filename, album, date_time, subjects, model_provider, model_name, last_indexed)
     VALUES (?, ?, 'local', 'a.jpg', ?, '2026-03-05T10:00:00', '["leopard"]', 'ollama', 'm', '2026-01-01T00:00:00.000Z')`,
    id,
    `hash-${id}-0123456789`,
    album
  );
}

beforeEach(async () => {
  await run('DELETE FROM faces');
  await run('DELETE FROM persons');
  await run('DELETE FROM photos');
  await run('DELETE FROM album_covers');
  await insertPhoto('kanha', 'Kanha');
  await insertPhoto('kanha2', 'Kanha');
  await insertPhoto('sund', 'Sundarbans');
  await insertPhoto('loose', null);
  await run(`UPDATE albums SET shared_with = '["viewer@example.com"]' WHERE name = 'Kanha'`);
  await run("UPDATE albums SET owner_email = 'other@example.com' WHERE name = 'Sundarbans'");
});

async function insertFace(id: string, photoId: string, personId: string | null = null, status = 'unassigned') {
  await run(
    `INSERT INTO faces (id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, det_score, embedding, embedding_model, person_id, assign_status, created_at)
     VALUES (?, ?, 0.1, 0.1, 0.3, 0.3, 0.9, zeroblob(2048), 'm', ?, ?, '2026-01-01T00:00:00.000Z')`,
    id,
    photoId,
    personId,
    status
  );
}
const personCount = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM persons').first<{ n: number }>())!.n;

describe('people and face writes need ownership', () => {
  // OWNER owns Kanha (shared with VIEWER) and person p1 with a confirmed face f1; f2 is unassigned.
  // OTHER owns Sundarbans, person po (face fs there) and nothing else.
  beforeEach(async () => {
    await run("INSERT INTO persons (id, name, owner_email, created_at) VALUES ('p1', 'P', 'owner@example.com', 'x'), ('po', 'Po', 'other@example.com', 'x')");
    await insertFace('f1', 'kanha', 'p1', 'confirmed');
    await insertFace('f2', 'kanha2');
    await insertFace('fs', 'sund', 'po', 'confirmed');
  });

  const writes: [string, string, unknown?][] = [
    ['POST', '/people', { name: 'X', faceIds: ['f2'] }],
    ['PATCH', '/people/p1', { name: 'Y' }],
    ['DELETE', '/people/p1'],
    ['POST', '/people/p1/faces', { faceIds: ['f2'] }],
    ['POST', '/people/p1/match', {}],
    ['POST', '/people/p1/cover', { faceId: 'f1' }],
    ['POST', '/faces/f2/assign', { personId: 'p1' }],
    ['POST', '/faces/f2/reject', { personId: 'p1' }],
    ['POST', '/faces/f1/unassign', {}],
  ];
  const snapshot = async () => JSON.stringify([
    (await env.DB.prepare('SELECT id, name, owner_email, cover_face_id FROM persons ORDER BY id').all()).results,
    (await env.DB.prepare('SELECT id, person_id, assign_status FROM faces ORDER BY id').all()).results,
    (await env.DB.prepare('SELECT * FROM face_rejections').all()).results,
  ]);

  it.each(writes)('%s %s: a viewer of the album gets 403, a stranger 404, and nothing changes', async (method, path, body) => {
    const before = await snapshot();
    expect((await send(method, path, VIEWER, body)).status).toBe(403);
    expect((await send(method, path, STRANGER, body)).status).toBe(404);
    expect(await snapshot()).toBe(before);
  });

  it('another owner cannot touch this owner\'s faces or people either way (404, nothing visible)', async () => {
    const before = await snapshot();
    expect((await send('POST', '/faces/f2/assign', OTHER, { personId: 'po' })).status).toBe(404);
    expect((await send('POST', '/faces/fs/assign', OWNER, { personId: 'p1' })).status).toBe(404);
    expect((await send('POST', '/faces/f2/assign', OWNER, { personId: 'po' })).status).toBe(404);
    expect((await send('PATCH', '/people/po', OWNER, { name: 'Z' })).status).toBe(404);
    expect(await snapshot()).toBe(before);
  });

  it('a viewer who can see another owner\'s person gets 403 on it, while their own faces need their own person', async () => {
    await run("UPDATE albums SET owner_email = ? WHERE name = 'Sundarbans'", VIEWER);
    await run("UPDATE persons SET owner_email = ? WHERE id = 'po'", VIEWER);
    // VIEWER owns Sundarbans and person po, and is shared Kanha: assign fs to po works, f2 (Kanha) is 403, p1 is 403.
    expect((await send('POST', '/faces/fs/assign', VIEWER, { personId: 'po' })).status).toBe(200);
    expect((await send('POST', '/faces/fs/assign', VIEWER, { personId: 'p1' })).status).toBe(403);
    expect((await send('POST', '/faces/f2/assign', VIEWER, { personId: 'po' })).status).toBe(403);
  });

  it('owners can create, rename, assign, reject, unassign, set a cover and delete their own people', async () => {
    const created = await send('POST', '/people', OWNER, { name: 'New', faceIds: ['f2'] });
    expect(created.status).toBe(201);
    const { id } = await created.json<any>();
    expect((await env.DB.prepare('SELECT owner_email FROM persons WHERE id = ?').bind(id).first<any>()).owner_email).toBe(OWNER);
    expect((await send('PATCH', `/people/${id}`, OWNER, { name: 'Newer' })).status).toBe(200);
    expect((await send('POST', `/people/${id}/cover`, OWNER, { faceId: 'f2' })).status).toBe(200);
    expect((await send('POST', '/faces/f2/unassign', OWNER, {})).status).toBe(200);
    expect((await send('POST', '/faces/f2/assign', OWNER, { personId: id })).status).toBe(200);
    expect((await send('POST', '/faces/f2/reject', OWNER, { personId: id })).status).toBe(200);
    expect((await send('POST', `/people/${id}/match`, OWNER, {})).status).toBe(200);
    expect((await send('DELETE', `/people/${id}`, OWNER)).status).toBe(204);
  });

  it('names are unique per owner, case-insensitively, and free across owners', async () => {
    expect((await send('POST', '/people', OWNER, { name: 'p' })).status).toBe(409);
    expect((await send('POST', '/people', OTHER, { name: 'p' })).status).toBe(201);
    expect((await send('POST', '/people', OTHER, { name: 'P' })).status).toBe(409);
    expect((await send('PATCH', '/people/p1', OWNER, { name: 'PO' })).status).toBe(200);
    expect(await personCount()).toBe(3);
  });

  it('a stranger may create a person of their own with no faces', async () => {
    expect((await send('POST', '/people', STRANGER, { name: 'Mine' })).status).toBe(201);
  });
});

describe('PATCH /photos/:id', () => {
  const edit = { caption: 'edited' };
  const caption = async (id: string) => (await env.DB.prepare('SELECT user_caption FROM photos WHERE id = ?').bind(id).first<{ user_caption: string | null }>())?.user_caption;

  it('lets the album owner edit, but nobody edits an album-less photo', async () => {
    expect((await send('PATCH', '/photos/kanha', OWNER, edit)).status).toBe(200);
    expect(await caption('kanha')).toBe('edited');
    expect((await send('PATCH', '/photos/loose', OWNER, edit)).status).toBe(404);
    expect((await send('PATCH', '/photos/sund', OTHER, edit)).status).toBe(200);
  });

  it('gives a viewer 403 and leaves the photo unchanged', async () => {
    const res = await send('PATCH', '/photos/kanha', VIEWER, edit);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('edited');
    expect(await caption('kanha')).toBeNull();
  });

  it('gives a stranger 404, on a shared photo and on an album-less one', async () => {
    expect((await send('PATCH', '/photos/kanha', STRANGER, edit)).status).toBe(404);
    expect((await send('PATCH', '/photos/loose', STRANGER, edit)).status).toBe(404);
    expect(await caption('kanha')).toBeNull();
  });

  it('gives an owner 404 on a photo in another user\'s album they cannot see', async () => {
    expect((await send('PATCH', '/photos/sund', OWNER, edit)).status).toBe(404);
  });

  it('one user can own X and be shared Y: edits X, cannot edit Y', async () => {
    await insertPhoto('x1', 'X');
    await insertPhoto('y1', 'Y');
    await run("UPDATE albums SET owner_email = ? WHERE name = 'X'", VIEWER);
    await run("UPDATE albums SET owner_email = 'other@example.com', shared_with = '[\"viewer@example.com\"]' WHERE name = 'Y'");
    expect((await send('PATCH', '/photos/x1', VIEWER, edit)).status).toBe(200);
    expect((await send('PATCH', '/photos/y1', VIEWER, edit)).status).toBe(403);
  });
});

describe('PUT /albums/cover', () => {
  it('owner succeeds, viewer 403, stranger 404', async () => {
    expect((await send('PUT', '/albums/cover', OWNER, { album: 'Kanha', photoId: 'kanha2' })).status).toBe(200);
    expect((await send('PUT', '/albums/cover', VIEWER, { album: 'Kanha', photoId: 'kanha' })).status).toBe(403);
    expect((await send('PUT', '/albums/cover', STRANGER, { album: 'Kanha', photoId: 'kanha' })).status).toBe(404);
    const cover = await env.DB.prepare("SELECT photo_id FROM album_covers WHERE album = 'Kanha'").first<{ photo_id: string }>();
    expect(cover?.photo_id).toBe('kanha2');
  });
});

describe('PUT /albums/shares', () => {
  it('lets the owner share, lowercases, dedupes and collapses case', async () => {
    const res = await send('PUT', '/albums/shares', OWNER, { album: 'Kanha', emails: ['Viewer@x.com', 'viewer@x.com', ' New@Example.com '] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ album: 'Kanha', emails: ['viewer@x.com', 'new@example.com'] });
    expect(JSON.parse((await sharedWith('Kanha'))!)).toEqual(['viewer@x.com', 'new@example.com']);
  });

  it('stores NULL for an empty list, and unsharing hides the album again', async () => {
    expect((await send('PUT', '/albums/shares', OWNER, { album: 'Kanha', emails: [] })).status).toBe(200);
    expect(await sharedWith('Kanha')).toBeNull();
    expect((await send('GET', '/photos/kanha', VIEWER)).status).toBe(404);
  });

  it('shares so the new viewer can read', async () => {
    await send('PUT', '/albums/shares', OWNER, { album: 'Kanha', emails: [STRANGER] });
    expect((await send('GET', '/photos/kanha', STRANGER)).status).toBe(200);
  });

  it('gives a viewer 403 and a stranger 404, unchanged', async () => {
    const before = await sharedWith('Kanha');
    expect((await send('PUT', '/albums/shares', VIEWER, { album: 'Kanha', emails: [] })).status).toBe(403);
    expect((await send('PUT', '/albums/shares', STRANGER, { album: 'Kanha', emails: [STRANGER] })).status).toBe(404);
    expect(await sharedWith('Kanha')).toBe(before);
  });

  it('gives 404 for an unknown album and for one the owner cannot see', async () => {
    expect((await send('PUT', '/albums/shares', STRANGER, { album: 'Nope', emails: [] })).status).toBe(404);
    expect((await send('PUT', '/albums/shares', OWNER, { album: 'Sundarbans', emails: [] })).status).toBe(404);
  });

  it('rejects invalid emails and more than 50', async () => {
    expect((await send('PUT', '/albums/shares', OWNER, { album: 'Kanha', emails: ['not-an-email'] })).status).toBe(400);
    const many = Array.from({ length: 51 }, (_, i) => `u${i}@example.com`);
    expect((await send('PUT', '/albums/shares', OWNER, { album: 'Kanha', emails: many })).status).toBe(400);
    expect((await send('PUT', '/albums/shares', OWNER, { emails: [] })).status).toBe(400);
    expect(await sharedWith('Kanha')).toBe('["viewer@example.com"]');
  });

  it('writes only shared_with', async () => {
    const before = await env.DB.prepare("SELECT name, owner_email, photo_count, cover_photo_id FROM albums WHERE name = 'Kanha'").first();
    await send('PUT', '/albums/shares', OWNER, { album: 'Kanha', emails: ['a@b.co'] });
    expect(await env.DB.prepare("SELECT name, owner_email, photo_count, cover_photo_id FROM albums WHERE name = 'Kanha'").first()).toEqual(before);
  });
});

describe('GET /access/photo/:id', () => {
  it('204 when visible, 404 when hidden or unknown', async () => {
    expect((await send('GET', '/access/photo/kanha', VIEWER)).status).toBe(204);
    expect((await send('GET', '/access/photo/kanha', OWNER)).status).toBe(204);
    expect((await send('GET', '/access/photo/kanha', STRANGER)).status).toBe(404);
    expect((await send('GET', '/access/photo/sund', OWNER)).status).toBe(404);
    expect((await send('GET', '/access/photo/missing', OWNER)).status).toBe(404);
  });
});

describe('write route enumeration', () => {
  it('every non-GET route outside /ingest/* is in the guarded registry', () => {
    const writes = app.routes.filter((r) => r.method !== 'GET' && r.method !== 'ALL' && !r.path.startsWith('/ingest/'));
    expect(writes.length).toBeGreaterThan(0);
    const unguarded = writes.map((r) => `${r.method} ${r.path}`).filter((k) => !guardedWrites.has(k));
    expect(unguarded).toEqual([]);
  });
});

describe('ingest and album ownership', () => {
  const payload = (id: string, album: string, extra: object = {}) => ({
    id,
    contentHash: `hash-${id}`,
    source: 'local',
    filename: 'a.jpg',
    album,
    description: 'd',
    suggestedCaption: 'c',
    modelProvider: 'ollama',
    modelName: 'm',
    ownerEmail: 'owner@example.com',
    ...extra,
  });
  const ingest = (body: unknown) =>
    SELF.fetch('https://example.com/ingest/photo', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.INGEST_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const U1 = '123e4567-e89b-12d3-a456-426614174001';
  const U2 = '123e4567-e89b-12d3-a456-426614174002';
  const count = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM photos').first<{ n: number }>())!.n;

  const owner = (album: string) => env.DB.prepare('SELECT owner_email FROM albums WHERE name = ?').bind(album).first<{ owner_email: string | null }>().then((r) => r?.owner_email);

  it('409s into another user\'s album and writes nothing', async () => {
    const before = await count();
    expect((await ingest(payload(U1, 'Sundarbans'))).status).toBe(409);
    expect(await count()).toBe(before);
  });

  it('requires a valid ownerEmail and lowercases it', async () => {
    const { ownerEmail: _drop, ...without } = payload(U1, 'Kanha') as Record<string, unknown>;
    expect((await ingest(without)).status).toBe(400);
    expect((await ingest(payload(U1, 'Kanha', { ownerEmail: 'not-an-email' }))).status).toBe(400);
    expect((await ingest(payload(U1, 'Kanha', { ownerEmail: '  Owner@Example.COM ' }))).status).toBe(201);
  });

  describe('stamping the album owner', () => {
    beforeEach(withoutAlbumOwnerFixture);
    afterEach(restoreAlbumOwnerFixture);

    it('the first photo of a new album stamps it, a later photo by the same owner keeps it', async () => {
      expect((await ingest(payload(U1, 'Brand New'))).status).toBe(201);
      expect(await owner('Brand New')).toBe(OWNER);
      expect((await ingest(payload(U2, 'Brand New'))).status).toBe(201);
      expect(await owner('Brand New')).toBe(OWNER);
    });

    it('stamps a NULL-owner album the first time, then 409s anyone else', async () => {
      await run("UPDATE albums SET owner_email = NULL WHERE name = 'Kanha'");
      expect((await ingest(payload(U1, 'Kanha'))).status).toBe(201);
      expect(await owner('Kanha')).toBe(OWNER);
      expect((await ingest(payload(U2, 'Kanha', { ownerEmail: 'other@example.com' }))).status).toBe(409);
      expect(await owner('Kanha')).toBe(OWNER);
    });

    it('409s and removes the new photo when another owner stamps the album first (race)', async () => {
      await run(`CREATE TRIGGER test_race AFTER INSERT ON albums WHEN new.owner_email IS NULL
        BEGIN UPDATE albums SET owner_email = 'other@example.com' WHERE name = new.name; END`);
      try {
        const before = await count();
        const res = await ingest(payload(U1, 'Raced'));
        expect(res.status).toBe(409);
        expect(await count()).toBe(before);
        expect(await owner('Raced')).toBeFalsy();
      } finally {
        await run('DROP TRIGGER test_race');
      }
    });

    it('does not stamp a photo without an album, and writes the stamp once per album', async () => {
      const { album: _a, ...noAlbum } = payload(U1, 'x') as Record<string, unknown>;
      expect((await ingest(noAlbum)).status).toBe(201);
      expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM albums WHERE owner_email IS NULL").first<{ n: number }>())!.n).toBe(0);
    });
  });

  it('drops owner_email and shared_with from the body', async () => {
    expect((await ingest(payload(U1, 'Kanha', { owner_email: 'evil@example.com', shared_with: ['evil@example.com'] }))).status).toBe(201);
    const a = await env.DB.prepare("SELECT owner_email, shared_with FROM albums WHERE name = 'Kanha'").first();
    expect(a).toEqual({ owner_email: 'owner@example.com', shared_with: '["viewer@example.com"]' });
  });
});
