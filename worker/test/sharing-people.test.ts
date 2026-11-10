import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { OWNER_TEST_EMAIL, readHeaders } from './helpers';

const OWNER = OWNER_TEST_EMAIL;
const VIEWER = 'viewer@example.com';
const STRANGER = 'stranger@example.com';

const run = (sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params).run();
const json = async (path: string, as: string) => (await SELF.fetch(`https://example.com${path}`, { headers: readHeaders(as) })).json<any>();

async function insertPhoto(id: string, album: string | null) {
  await run(
    `INSERT INTO photos (id, content_hash, source, filename, album, date_time, aesthetic_score, subjects, model_provider, model_name, last_indexed)
     VALUES (?, ?, 'local', 'a.jpg', ?, '2026-03-05T10:00:00', 8, '["leopard"]', 'ollama', 'm', '2026-01-01T00:00:00.000Z')`,
    id,
    `hash-${id}-0123456789`,
    album
  );
}

async function insertFace(id: string, photoId: string, personId: string | null, status: string, w = 1) {
  await run(
    `INSERT INTO faces (id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, det_score, embedding, embedding_model, crop_key, person_id, assign_status, created_at)
     VALUES (?, ?, 0, 0, ?, 1, 0.9, x'00', 'm', NULL, ?, ?, '2026-01-01T00:00:00.000Z')`,
    id,
    photoId,
    w,
    personId,
    status
  );
}

describe('album sharing: people, faces and daily pick', () => {
  beforeEach(async () => {
    await run('DELETE FROM faces');
    await run('DELETE FROM persons');
    await run('DELETE FROM photos');
    await insertPhoto('kanha', 'Kanha');
    await insertPhoto('kanha2', 'Kanha');
    await insertPhoto('ranth', 'Ranthambore');
    await run(`UPDATE albums SET shared_with = '["viewer@example.com"]' WHERE name = 'Kanha'`);
    await run("UPDATE albums SET owner_email = 'other@example.com' WHERE name = 'Ranthambore'");
    await run("INSERT INTO persons (id, name, created_at) VALUES ('p-mixed', 'Mixed', 'x'), ('p-hidden', 'Hidden', 'x')");
    await insertFace('f-vis', 'kanha', 'p-mixed', 'confirmed');
    await insertFace('f-vis2', 'kanha2', 'p-mixed', 'auto');
    await insertFace('f-inv', 'ranth', 'p-mixed', 'confirmed', 5);
    await insertFace('f-hid', 'ranth', 'p-hidden', 'confirmed');
    await insertFace('f-unassigned', 'kanha', null, 'unassigned');
  });

  it('counts only visible faces and photos for a viewer, and hides people with none', async () => {
    const { people } = await json('/people', VIEWER);
    expect(people.map((p: any) => p.id)).toEqual(['p-mixed']);
    expect(people[0].faceCount).toBe(2);
    expect(people[0].photoCount).toBe(2);
  });

  it('shows a stranger no people', async () => {
    expect((await json('/people', STRANGER)).people).toEqual([]);
  });

  it('lists every person for the default owner, with counts over visible photos', async () => {
    const { people } = await json('/people', OWNER);
    expect(people.map((p: any) => p.id)).toEqual(['p-hidden', 'p-mixed']);
    // Ranthambore is owned by someone else, so only the Kanha faces count for the default owner too.
    expect(people.find((p: any) => p.id === 'p-mixed').faceCount).toBe(2);
    // The default owner still manages people with no visible faces, with zero counts.
    expect(people.find((p: any) => p.id === 'p-hidden').faceCount).toBe(0);
  });

  it('falls back to a visible face when cover_face_id is in an invisible photo', async () => {
    await run("UPDATE persons SET cover_face_id = 'f-inv' WHERE id = 'p-mixed'");
    const { people } = await json('/people', VIEWER);
    expect(['f-vis', 'f-vis2']).toContain(people[0].cover.id);
    expect(people[0].cover.photoId).not.toBe('ranth');
  });

  it('returns empty groups for non-default users', async () => {
    expect(await json('/people/groups', VIEWER)).toEqual({ groups: [], scanned: 0, nextCursor: null });
    expect(await json('/people/groups', STRANGER)).toEqual({ groups: [], scanned: 0, nextCursor: null });
  });

  it('daily pick for a viewer is read-only, visible-only and not editable', async () => {
    await run("UPDATE photos SET instagram_suggested = '2020-01-01T00:00:00.000Z' WHERE id = 'ranth'");
    const res = await SELF.fetch('https://example.com/daily-pick', { headers: readHeaders(VIEWER) });
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(['kanha', 'kanha2']).toContain(body.photo.id);
    expect(body.photo.canEdit).toBe(false);
    const rows = await env.DB.prepare('SELECT id, instagram_suggested FROM photos').all<any>();
    expect(rows.results.filter((r) => r.instagram_suggested).map((r) => r.id)).toEqual(['ranth']);
  });

  it('daily pick for a viewer does not say "you gave it" for the owner\'s star rating', async () => {
    await run("UPDATE photos SET user_rating = 5 WHERE album = 'Kanha'");
    const viewer = await json('/daily-pick', VIEWER);
    expect(viewer.reason).not.toContain('you gave it');
    expect(viewer.reason).toContain('for visual quality');
    const owner = await json('/daily-pick', OWNER);
    expect(owner.reason).toContain('you gave it 5 stars');
  });

  it('daily pick for a viewer breaks score ties by id', async () => {
    await run('DELETE FROM faces');
    await run('DELETE FROM photos');
    // Inserted out of id order with identical scores: the pick must not depend on scan order.
    await insertPhoto('zz', 'Kanha');
    await insertPhoto('aa', 'Kanha');
    await run(`UPDATE albums SET shared_with = '["viewer@example.com"]' WHERE name = 'Kanha'`);
    expect((await json('/daily-pick', VIEWER)).photo.id).toBe('aa');
  });

  it('daily pick for a stranger is 404', async () => {
    const res = await SELF.fetch('https://example.com/daily-pick', { headers: readHeaders(STRANGER) });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('No photos available');
  });

  it('daily pick for the default owner never picks an invisible photo, and still writes', async () => {
    await run("UPDATE photos SET aesthetic_score = 10 WHERE id = 'ranth'");
    const body = await json('/daily-pick', OWNER);
    expect(['kanha', 'kanha2']).toContain(body.photo.id);
    expect(body.photo.canEdit).toBe(true);
    const row = await env.DB.prepare('SELECT instagram_suggested FROM photos WHERE id = ?').bind(body.photo.id).first<any>();
    expect(row.instagram_suggested).toBeTruthy();
  });
});
