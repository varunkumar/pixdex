import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { autoMatchFaces } from '../src/people/autoMatch';
import { embeddingToBytes } from '../src/people/embedding';
import { loadReferences } from '../src/people/references';
import { IGNORED_PAGE_SIZE } from '../src/routes/people';
import { OWNER_TEST_EMAIL, readHeaders } from './helpers';

const OWNER = OWNER_TEST_EMAIL;
const VIEWER = 'viewer@example.com';
const OTHER = 'other@example.com';
const HASH = 'hash-ignore-0123456789';
const MODEL = 'buffalo_l';

const run = (sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params).run();
const send = (method: string, path: string, body?: unknown, as: string = OWNER) =>
  SELF.fetch(`https://example.com${path}`, {
    method,
    headers: { ...readHeaders(as), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async <T = any>(path: string, as: string = OWNER) => (await (await send('GET', path, undefined, as)).json()) as T;
const ignore = (...faceIds: string[]) => send('POST', '/faces/ignore', { faceIds });
const restore = (...faceIds: string[]) => send('POST', '/faces/restore', { faceIds });
const row = (id: string) => env.DB.prepare('SELECT * FROM faces WHERE id = ?').bind(id).first<any>();

/** Every face uses the same unit vector, so any two faces score 1 against each other. */
const vector = new Float32Array(512);
vector[0] = 1;
const embedding = embeddingToBytes(vector).buffer;
const base64 = (() => {
  let s = '';
  for (const b of new Uint8Array(embedding)) s += String.fromCharCode(b);
  return btoa(s);
})();

type Seed = { photo?: string; x?: number; person?: string | null; status?: string; known?: string | null; ignoredAt?: string | null };
async function addFace(id: string, o: Seed = {}) {
  await run(
    `INSERT INTO faces (id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, det_score, embedding, embedding_model,
       person_id, assign_status, known_id, known_score, ignored_at, created_at)
     VALUES (?, ?, ?, 0.1, 0.2, 0.2, 0.9, ?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
    id, o.photo ?? 'ph1', o.x ?? 0.1, embedding, MODEL, o.person ?? null, o.status ?? 'unassigned',
    o.known ?? null, o.known ? 0.8 : null, o.ignoredAt ?? null
  );
}

async function addPhoto(id: string, album: string, hash = `hash-${id}`) {
  await run(
    // Dated, so the photo shows up in the timeline.
    `INSERT INTO photos (id, content_hash, source, filename, album, date_time, subjects, model_provider, model_name, last_indexed)
     VALUES (?, ?, 'local', 'a.jpg', ?, '2026-03-05T10:00:00', '[]', 'ollama', 'm', '2026-01-01T00:00:00.000Z')`,
    id, hash, album
  );
}

beforeEach(async () => {
  for (const t of ['face_rejections', 'faces', 'persons', 'photos', 'known_people']) await run(`DELETE FROM ${t}`);
  await addPhoto('ph1', 'Kanha', HASH);
  await addPhoto('ph2', 'Sundarbans');
  await run("UPDATE albums SET owner_email = ?, shared_with = ? WHERE name = 'Kanha'", OWNER, JSON.stringify([VIEWER]));
  await run("UPDATE albums SET owner_email = ?, shared_with = NULL WHERE name = 'Sundarbans'", OTHER);
  await run("INSERT INTO persons (id, name, owner_email, created_at) VALUES ('p1', 'Asha', ?, 'x')", OWNER);
  await run("INSERT INTO known_people (id, name, created_at) VALUES ('Q1', 'Known One', 'x')");
});

describe('POST /faces/ignore and /faces/restore', () => {
  it('ignores unassigned faces only, once, and restores them', async () => {
    await addFace('u1');
    await addFace('u2', { x: 0.4 });
    await addFace('a1', { person: 'p1', status: 'auto' });
    await addFace('c1', { person: 'p1', status: 'confirmed' });
    const res = await ignore('u1', 'u2', 'a1', 'c1', 'u1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ignored: 2 });
    expect((await row('u1')).ignored_at).not.toBeNull();
    expect((await row('a1'))).toMatchObject({ ignored_at: null, person_id: 'p1', assign_status: 'auto' });
    expect((await row('c1')).ignored_at).toBeNull();
    const stamp = (await row('u1')).ignored_at;
    expect(await (await ignore('u1')).json()).toEqual({ ignored: 0 });
    expect((await row('u1')).ignored_at).toBe(stamp);
    expect(await (await restore('u1', 'c1')).json()).toEqual({ restored: 1 });
    expect(await row('u1')).toMatchObject({ ignored_at: null, assign_status: 'unassigned', person_id: null });
    expect((await row('u2')).ignored_at).not.toBeNull();
  });

  it.each(['/faces/ignore', '/faces/restore'])('%s changes nothing for a mixed owned and foreign list', async (path) => {
    await addFace('u1', { ignoredAt: path.endsWith('restore') ? 't' : null });
    await addFace('theirs', { photo: 'ph2' });
    const before = await row('u1');
    expect((await send('POST', path, { faceIds: ['u1', 'theirs'] })).status).toBe(404);
    expect((await send('POST', path, { faceIds: ['u1'] }, VIEWER)).status).toBe(403);
    expect((await send('POST', path, { faceIds: ['u1', 'missing'] })).status).toBe(404);
    expect(await row('u1')).toEqual(before);
  });

  it.each([[{}], [{ faceIds: [] }], [{ faceIds: Array.from({ length: 201 }, (_, i) => `f${i}`) }]])('rejects a bad body', async (body) => {
    expect((await send('POST', '/faces/ignore', body)).status).toBe(400);
    expect((await send('POST', '/faces/restore', body)).status).toBe(400);
  });

  it('naming an ignored face clears the flag', async () => {
    await addFace('u1', { ignoredAt: 't' });
    expect((await send('POST', '/faces/u1/assign', { personId: 'p1' })).status).toBe(200);
    expect(await row('u1')).toMatchObject({ ignored_at: null, assign_status: 'confirmed', person_id: 'p1' });
  });
});

describe('ignored faces are left out', () => {
  beforeEach(async () => {
    await addFace('ref', { person: 'p1', status: 'confirmed', x: 0.7 });
    await addFace('open');
    await addFace('gone', { x: 0.4, ignoredAt: '2026-02-01T00:00:00.000Z' });
  });

  it('of unnamed groups', async () => {
    const body = await json('/people/groups');
    expect(body.groups.flatMap((g: any) => g.faces.map((f: any) => f.id))).toEqual(['open']);
    expect(body.scanned).toBe(1);
  });

  it('of person matching, both suggested and applied', async () => {
    const res = await send('POST', '/people/p1/match', { apply: true });
    const body = (await res.json()) as any;
    expect([...body.auto, ...body.suggestions].map((f: any) => f.id)).toEqual(['open']);
    expect(await row('gone')).toMatchObject({ assign_status: 'unassigned', person_id: null });
  });

  it('of ingest auto-match', async () => {
    expect(await autoMatchFaces(env.DB, ['open', 'gone'])).toEqual({ matched: 1, skipped: 0 });
    expect(await row('gone')).toMatchObject({ assign_status: 'unassigned', person_id: null });
  });

  it('of references, which only hold confirmed faces', async () => {
    await ignore('ref');
    const [refs] = await loadReferences(env.DB, { personId: 'p1' });
    expect(refs.vectors).toHaveLength(1);
    expect((await row('ref')).ignored_at).toBeNull();
  });

  it('marks the photo face as ignored', async () => {
    const { faces } = await json('/photos/ph1/faces');
    expect(Object.fromEntries(faces.map((f: any) => [f.id, f.ignored]))).toEqual({ ref: false, open: false, gone: true });
  });
});

describe('known-personality matches of ignored faces', () => {
  beforeEach(() => addFace('k1', { known: 'Q1' }));

  const seen = async (as: string) => ({
    list: (await json('/people/known', as)).known.map((k: any) => k.id),
    search: (await json('/search?known=Q1', as)).total,
    timeline: (await json('/timeline?known=Q1', as)).groups.length,
    album: (await json('/albums/contents?name=Kanha', as)).known.map((k: any) => [k.id, k.cover?.id]),
  });
  const shown = { list: ['Q1'], search: 1, timeline: 1, album: [['Q1', 'k1']] };
  const hidden = { list: [], search: 0, timeline: 0, album: [] };

  it('are hidden from owner and viewers, and come back on restore', async () => {
    expect(await seen(OWNER)).toEqual(shown);
    await ignore('k1');
    expect(await seen(OWNER)).toEqual(hidden);
    expect(await seen(VIEWER)).toEqual(hidden);
    expect(await row('k1')).toMatchObject({ known_id: 'Q1', known_score: 0.8 });
    await restore('k1');
    expect(await seen(OWNER)).toEqual(shown);
  });
});

describe('rescan', () => {
  const post = (faces: unknown[]) =>
    SELF.fetch('https://example.com/ingest/faces', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.INGEST_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentHash: HASH, model: MODEL, faces }),
    });
  const scanned = (x: number, extra: Record<string, unknown> = {}) => ({
    bbox: { x, y: 0.1, w: 0.2, h: 0.2 }, detScore: 0.9, embedding: base64, ...extra,
  });

  it('keeps an ignored face with its crop, rejection and known match, and drops the overlapping new one', async () => {
    await addFace('gone', { known: 'Q1', ignoredAt: 't' });
    await run("UPDATE faces SET crop_key = 'faces/gone.jpg' WHERE id = 'gone'");
    await env.THUMBNAILS.put('faces/gone.jpg', new Uint8Array([1]));
    await run("INSERT INTO face_rejections (face_id, person_id) VALUES ('gone', 'p1')");
    await addFace('old', { x: 0.6 });

    const res = await post([scanned(0.11), scanned(0.6)]);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ stored: 1, kept: 1 });
    expect(body.faceIds[0]).toBe('gone');
    expect(await row('gone')).toMatchObject({ ignored_at: 't', crop_key: 'faces/gone.jpg', known_id: 'Q1', assign_status: 'unassigned' });
    expect(await row('old')).toBeNull();
    expect(await env.THUMBNAILS.get('faces/gone.jpg')).not.toBeNull();
    expect((await env.DB.prepare('SELECT face_id FROM face_rejections').all()).results).toEqual([{ face_id: 'gone' }]);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM faces').first<{ n: number }>())!.n).toBe(2);
  });

  it('keeps an ignored face the new scan did not find', async () => {
    await addFace('gone', { ignoredAt: 't' });
    await post([]);
    expect(await row('gone')).toMatchObject({ ignored_at: 't' });
  });

  it('never takes the ignored flag from an ingest body', async () => {
    await post([scanned(0.1, { ignoredAt: 't', ignored_at: 't' })]);
    const { results } = await env.DB.prepare('SELECT ignored_at FROM faces').all();
    expect(results).toEqual([{ ignored_at: null }]);
  });
});

describe('GET /people/ignored', () => {
  it('lists only the caller-owned ignored faces, newest first, paging through tied timestamps', async () => {
    const total = IGNORED_PAGE_SIZE + 5;
    for (let i = 0; i < total; i++) await addFace(`t${i}`, { ignoredAt: '2026-02-01T00:00:00.000Z' });
    await addFace('newest', { ignoredAt: '2026-03-01T00:00:00.000Z' });
    await addFace('oldest', { ignoredAt: '2026-01-01T00:00:00.000Z' });
    await addFace('theirs', { photo: 'ph2', ignoredAt: '2026-04-01T00:00:00.000Z' });
    await addFace('open');
    const first = await json('/people/ignored');
    expect(first.faces).toHaveLength(IGNORED_PAGE_SIZE);
    expect(first.faces[0]).toMatchObject({ id: 'newest', ignored: true });
    expect(first.faces[0]).not.toHaveProperty('embedding');
    const second = await json(`/people/ignored?cursor=${encodeURIComponent(first.nextCursor)}`);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.faces, ...second.faces].map((f: any) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(total + 2);
    expect(ids.at(-1)).toBe('oldest');
  });

  it('is empty for a user who owns no album', async () => {
    await addFace('gone', { ignoredAt: 't' });
    expect(await json('/people/ignored', VIEWER)).toEqual({ faces: [], nextCursor: null });
  });

  it.each(['', 'x', '12', 't|', '|3', 't|abc', 't|1|2'])('rejects the cursor %j', async (cursor) => {
    expect((await send('GET', `/people/ignored?cursor=${encodeURIComponent(cursor)}`)).status).toBe(400);
  });
});
