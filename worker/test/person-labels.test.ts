import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { OWNER_TEST_EMAIL, readHeaders } from './helpers';

const OWNER = OWNER_TEST_EMAIL;
const VIEWER = 'viewer@example.com';
const VIEWER2 = 'viewer2@example.com';
const STRANGER = 'stranger@example.com';

const run = (sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params).run();
const send = (method: string, path: string, as: string, body?: unknown) =>
  SELF.fetch(`https://example.com${path}`, {
    method,
    headers: { ...readHeaders(as), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const get = async (path: string, as: string) => (await send('GET', path, as)).json<any>();
const labelRows = async () => (await env.DB.prepare('SELECT viewer_email, person_id, name FROM person_labels ORDER BY viewer_email, person_id').all()).results;

async function insertPhoto(id: string, album: string) {
  await run(
    `INSERT INTO photos (id, content_hash, source, filename, album, date_time, subjects, model_provider, model_name, last_indexed)
     VALUES (?, ?, 'local', 'a.jpg', ?, '2026-03-05T10:00:00', '["leopard"]', 'ollama', 'm', '2026-01-01T00:00:00.000Z')`,
    id,
    `hash-${id}-0123456789`,
    album
  );
}
async function insertFace(id: string, photoId: string, personId: string | null, status: string) {
  await run(
    `INSERT INTO faces (id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, det_score, embedding, embedding_model, crop_key, person_id, assign_status, created_at)
     VALUES (?, ?, 0, 0, 1, 1, 0.9, x'00', 'm', NULL, ?, ?, '2026-01-01T00:00:00.000Z')`,
    id,
    photoId,
    personId,
    status
  );
}

describe('viewer-private person labels', () => {
  beforeEach(async () => {
    await run('DELETE FROM person_labels');
    await run('DELETE FROM faces');
    await run('DELETE FROM persons');
    await run('DELETE FROM photos');
    await insertPhoto('kanha', 'Kanha');
    await insertPhoto('ranth', 'Ranthambore');
    await run(`UPDATE albums SET shared_with = '["viewer@example.com","viewer2@example.com"]' WHERE name = 'Kanha'`);
    await run("UPDATE albums SET owner_email = 'other@example.com' WHERE name = 'Ranthambore'");
    await run("INSERT INTO persons (id, name, owner_email, created_at) VALUES ('mom', 'Mom', 'owner@example.com', 'x'), ('zed', 'Zed', 'owner@example.com', 'x'), ('hid', 'Hidden', 'owner@example.com', 'x')");
    await insertFace('f1', 'kanha', 'mom', 'confirmed');
    await insertFace('f2', 'kanha', 'zed', 'auto');
    await insertFace('f3', 'ranth', 'hid', 'confirmed');
  });

  it('a viewer never receives the owner name, on the list, the cover or the photo faces', async () => {
    const { people } = await get('/people', VIEWER);
    expect(people.map((p: any) => [p.id, p.name])).toEqual([['mom', null], ['zed', null]]);
    for (const p of people) expect(p.cover.personName).toBeNull();
    const { faces } = await get('/photos/kanha/faces', VIEWER);
    expect(faces.map((f: any) => f.personName)).toEqual([null, null]);
    expect(JSON.stringify([people, faces])).not.toMatch(/Mom|Zed/);
  });

  it('the owner still sees their own names', async () => {
    const { people } = await get('/people', OWNER);
    expect(people.map((p: any) => p.name)).toEqual(['Hidden', 'Mom', 'Zed']);
    expect((await get('/photos/kanha/faces', OWNER)).faces.map((f: any) => f.personName)).toEqual(['Mom', 'Zed']);
  });

  it('PUT sets the label, which then resolves in the list, cover and faces, and sorts the list', async () => {
    expect((await send('PUT', '/people/mom/label', VIEWER, { name: '  Mum ' })).status).toBe(200);
    expect((await send('PUT', '/people/zed/label', VIEWER, { name: 'Aunt' })).status).toBe(200);
    const { people } = await get('/people', VIEWER);
    expect(people.map((p: any) => p.name)).toEqual(['Aunt', 'Mum']);
    expect(people.find((p: any) => p.id === 'mom').cover.personName).toBe('Mum');
    expect((await get('/photos/kanha/faces', VIEWER)).faces.map((f: any) => f.personName)).toEqual(['Mum', 'Aunt']);
    // Update in place, not a second row.
    await send('PUT', '/people/mom/label', VIEWER, { name: 'Mama' });
    expect((await labelRows()).filter((r: any) => r.person_id === 'mom')).toHaveLength(1);
    expect((await get('/people', VIEWER)).people.map((p: any) => p.name)).toEqual(['Aunt', 'Mama']);
  });

  it('unnamed people sort after named ones', async () => {
    await send('PUT', '/people/zed/label', VIEWER, { name: 'Zoe' });
    expect((await get('/people', VIEWER)).people.map((p: any) => p.name)).toEqual(['Zoe', null]);
  });

  it('DELETE clears the label and is idempotent', async () => {
    await send('PUT', '/people/mom/label', VIEWER, { name: 'Mum' });
    expect((await send('DELETE', '/people/mom/label', VIEWER)).status).toBe(204);
    expect((await send('DELETE', '/people/mom/label', VIEWER)).status).toBe(204);
    expect((await get('/people', VIEWER)).people[0].name).toBeNull();
  });

  it('labels are per viewer', async () => {
    await send('PUT', '/people/mom/label', VIEWER, { name: 'Mum' });
    await send('PUT', '/people/mom/label', VIEWER2, { name: 'Aunt Mo' });
    expect((await get('/people', VIEWER)).people[0].name).toBe('Mum');
    expect((await get('/people', VIEWER2)).people[0].name).toBe('Aunt Mo');
    expect((await get('/people', OWNER)).people.find((p: any) => p.id === 'mom').name).toBe('Mom');
    await send('DELETE', '/people/mom/label', VIEWER);
    expect((await get('/people', VIEWER2)).people[0].name).toBe('Aunt Mo');
  });

  it('404 for a person the caller cannot see (and for an unknown one), nothing written', async () => {
    expect((await send('PUT', '/people/hid/label', VIEWER, { name: 'X' })).status).toBe(404);
    expect((await send('PUT', '/people/mom/label', STRANGER, { name: 'X' })).status).toBe(404);
    expect((await send('DELETE', '/people/nope/label', VIEWER)).status).toBe(404);
    expect(await labelRows()).toEqual([]);
  });

  it('400 for the owner of the person, and for a bad body', async () => {
    expect((await send('PUT', '/people/mom/label', OWNER, { name: 'X' })).status).toBe(400);
    expect((await send('DELETE', '/people/mom/label', OWNER)).status).toBe(400);
    expect((await send('PUT', '/people/mom/label', VIEWER, { name: '   ' })).status).toBe(400);
    expect((await send('PUT', '/people/mom/label', VIEWER, { name: 'x'.repeat(81) })).status).toBe(400);
    expect((await send('PUT', '/people/mom/label', VIEWER, {})).status).toBe(400);
    expect(await labelRows()).toEqual([]);
  });

  it('409 when the name clashes (case-insensitively) with another of the viewer label, but not another viewer or the same person', async () => {
    await send('PUT', '/people/mom/label', VIEWER, { name: 'Mum' });
    expect((await send('PUT', '/people/zed/label', VIEWER, { name: 'mUM' })).status).toBe(409);
    expect((await send('PUT', '/people/mom/label', VIEWER, { name: 'MUM' })).status).toBe(200);
    expect((await send('PUT', '/people/zed/label', VIEWER2, { name: 'Mum' })).status).toBe(200);
  });

  it('the database enforces the clash rule and lowercase emails', async () => {
    await run("INSERT INTO person_labels VALUES ('viewer@example.com', 'mom', 'Mum', 'x')");
    await expect(run("INSERT INTO person_labels VALUES ('viewer@example.com', 'zed', 'MUM', 'x')")).rejects.toThrow();
    await expect(run("INSERT INTO person_labels VALUES ('Viewer@example.com', 'zed', 'Zed', 'x')")).rejects.toThrow();
  });

  it('a label never gives a viewer write access', async () => {
    await send('PUT', '/people/mom/label', VIEWER, { name: 'Mum' });
    expect((await send('PATCH', '/people/mom', VIEWER, { name: 'Mum' })).status).toBe(403);
    expect((await send('DELETE', '/people/mom', VIEWER)).status).toBe(403);
    expect((await send('POST', '/people/mom/match', VIEWER, {})).status).toBe(403);
    expect((await get('/people', OWNER)).people.find((p: any) => p.id === 'mom').name).toBe('Mom');
  });

  it('deleting a person removes every viewer label for it, and only those', async () => {
    await send('PUT', '/people/mom/label', VIEWER, { name: 'Mum' });
    await send('PUT', '/people/mom/label', VIEWER2, { name: 'Mo' });
    await send('PUT', '/people/zed/label', VIEWER, { name: 'Zed2' });
    expect((await send('DELETE', '/people/mom', OWNER)).status).toBe(204);
    expect(await labelRows()).toEqual([{ viewer_email: VIEWER, person_id: 'zed', name: 'Zed2' }]);
    // Any other deletion path too (the trigger).
    await run("DELETE FROM persons WHERE id = 'zed'");
    expect(await labelRows()).toEqual([]);
  });

  it('search and timeline filter by person id only, never by (owner) name', async () => {
    const byName = await get('/search?people=Mom', VIEWER);
    expect(byName.results).toEqual([]);
    const byText = await get('/search?q=Mom', VIEWER);
    expect(byText.results).toEqual([]);
    const byId = await get('/search?people=mom', VIEWER);
    expect(byId.results.map((r: any) => r.id)).toEqual(['kanha']);
    expect(JSON.stringify(byId)).not.toMatch(/Mom/);
  });

  it('the label join is a primary key search on person_labels', async () => {
    const r = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT CASE WHEN p.owner_email = ? THEN p.name
        ELSE (SELECT pl.name FROM person_labels pl WHERE pl.viewer_email = ? AND pl.person_id = p.id) END FROM persons p`
    ).bind(VIEWER, VIEWER).all<{ detail: string }>();
    expect(r.results.map((x) => x.detail).join('\n')).toMatch(/SEARCH pl USING (COVERING )?INDEX sqlite_autoindex_person_labels_1 \(viewer_email=\? AND person_id=\?\)/);
  });
});
