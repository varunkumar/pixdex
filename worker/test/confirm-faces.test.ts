import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { embeddingToBytes } from '../src/people/embedding';
import { AUTO_PAGE_SIZE } from '../src/routes/people';
import { OWNER_TEST_EMAIL, readHeaders } from './helpers';

const OWNER = OWNER_TEST_EMAIL;
const VIEWER = 'viewer@example.com';
const OTHER = 'other@example.com';

const run = (sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params).run();
const send = (method: string, path: string, body?: unknown, as: string = OWNER) =>
  SELF.fetch(`https://example.com${path}`, {
    method,
    headers: { ...readHeaders(as), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const list = (cursor?: string | null, as: string = OWNER, person = 'p1') =>
  send('GET', `/people/${person}/auto-faces${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, undefined, as);
const review = (body: unknown, as: string = OWNER) => send('POST', '/people/p1/auto-faces/review', body, as);
const row = (id: string) => env.DB.prepare('SELECT * FROM faces WHERE id = ?').bind(id).first<any>();
const rejections = async () =>
  (await env.DB.prepare('SELECT face_id, person_id FROM face_rejections ORDER BY face_id, person_id').all()).results;

/** Every face uses the same unit vector, so any two faces score 1 against each other. */
const vector = new Float32Array(512);
vector[0] = 1;
const embedding = embeddingToBytes(vector).buffer;

type Seed = { photo?: string; person?: string | null; status?: string; score?: number | null; ignoredAt?: string | null };
async function addFace(id: string, o: Seed = {}) {
  const status = o.status ?? 'auto';
  await run(
    `INSERT INTO faces (id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, det_score, embedding, embedding_model,
       person_id, assign_status, match_score, ignored_at, created_at)
     VALUES (?, ?, 0.1, 0.1, 0.2, 0.2, 0.9, ?, 'buffalo_l', ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
    id, o.photo ?? 'ph1', embedding, o.person === undefined ? 'p1' : o.person, status,
    o.score === undefined ? (status === 'auto' ? 0.6 : null) : o.score, o.ignoredAt ?? null
  );
}

async function addPhoto(id: string, album: string) {
  await run(
    `INSERT INTO photos (id, content_hash, source, filename, album, date_time, subjects, model_provider, model_name, last_indexed)
     VALUES (?, ?, 'local', 'a.jpg', ?, '2026-03-05T10:00:00', '[]', 'ollama', 'm', '2026-01-01T00:00:00.000Z')`,
    id, `hash-confirm-${id}`, album
  );
}

beforeEach(async () => {
  for (const t of ['face_rejections', 'faces', 'persons', 'photos']) await run(`DELETE FROM ${t}`);
  await addPhoto('ph1', 'Kanha');
  await addPhoto('ph2', 'Sundarbans');
  await run("UPDATE albums SET owner_email = ?, shared_with = ? WHERE name = 'Kanha'", OWNER, JSON.stringify([VIEWER]));
  await run("UPDATE albums SET owner_email = ?, shared_with = ? WHERE name = 'Sundarbans'", OTHER, JSON.stringify([OWNER]));
  await run("INSERT INTO persons (id, name, owner_email, created_at) VALUES ('p1', 'Asha', ?, 'x'), ('p2', 'Bina', ?, 'x')", OWNER, OWNER);
});

describe('GET /people/:id/auto-faces', () => {
  it("lists this person's auto faces in owned albums only, weakest match first", async () => {
    await addFace('strong', { score: 0.9 });
    await addFace('weak', { score: 0.51 });
    await addFace('mid', { score: 0.7 });
    await addFace('done', { status: 'confirmed' });
    await addFace('else', { person: 'p2' });
    await addFace('open', { person: null, status: 'unassigned', score: null });
    await addFace('shared', { photo: 'ph2' });
    const res = await list();
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.faces.map((f: any) => f.id)).toEqual(['weak', 'mid', 'strong']);
    expect(body.faces[0]).toMatchObject({ personId: 'p1', personName: 'Asha', status: 'auto', matchScore: 0.51, photoId: 'ph1' });
    expect(body.faces[0]).not.toHaveProperty('embedding');
    expect(body.nextCursor).toBeNull();
  });

  it('pages through tied scores without losing or repeating a face', async () => {
    const total = AUTO_PAGE_SIZE * 2 + 4;
    const scores = [0.5 + 1 / 3, 0.6000000238418579, 0.9];
    for (let i = 0; i < total; i++) await addFace(`f${i}`, { score: scores[i % 3] });
    const seen: { id: string; matchScore: number }[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    do {
      const body: any = await (await list(cursor)).json();
      sizes.push(body.faces.length);
      seen.push(...body.faces);
      cursor = body.nextCursor;
    } while (cursor);
    expect(sizes).toEqual([48, 48, 4]);
    expect(new Set(seen.map((f) => f.id)).size).toBe(total);
    expect(seen.map((f) => f.matchScore)).toEqual([...seen.map((f) => f.matchScore)].sort((a, b) => a - b));
  });

  it('keeps the next page right after the faces of the previous one are confirmed', async () => {
    for (let i = 0; i < AUTO_PAGE_SIZE + 2; i++) await addFace(`f${i}`, { score: 0.5 + i / 1000 });
    const first: any = await (await list()).json();
    await review({ confirm: first.faces.map((f: any) => f.id) });
    const second: any = await (await list(first.nextCursor)).json();
    expect(second.faces.map((f: any) => f.id)).toEqual([`f${AUTO_PAGE_SIZE}`, `f${AUTO_PAGE_SIZE + 1}`]);
  });

  it.each(['x', '0.5', '0.5|', '|3', '0.5|3|4', 'NaN|3'])('rejects the cursor %s', async (cursor) => {
    expect((await list(cursor)).status).toBe(400);
  });

  it('is for the person owner only', async () => {
    await addFace('a');
    expect((await list(null, VIEWER)).status).toBe(403);
    expect((await list(null, 'stranger@example.com')).status).toBe(404);
    expect((await list(null, OWNER, 'nobody')).status).toBe(404);
  });
});

describe('POST /people/:id/auto-faces/review', () => {
  it('confirms and rejects in one call', async () => {
    await addFace('yes');
    await addFace('no');
    await addFace('later');
    const res = await review({ confirm: ['yes', 'yes'], reject: ['no'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ confirmed: ['yes'], rejected: ['no'] });
    expect(await row('yes')).toMatchObject({ person_id: 'p1', assign_status: 'confirmed', match_score: null });
    expect(await row('no')).toMatchObject({ person_id: null, assign_status: 'unassigned', match_score: null });
    expect(await row('later')).toMatchObject({ person_id: 'p1', assign_status: 'auto', match_score: 0.6 });
    expect(await rejections()).toEqual([{ face_id: 'no', person_id: 'p1' }]);
  });

  it('skips every face that is no longer an auto match of this person in an owned album', async () => {
    await addFace('confirmed', { status: 'confirmed' });
    await addFace('moved', { person: 'p2' });
    await addFace('open', { person: null, status: 'unassigned', score: null });
    await addFace('ignored', { person: null, status: 'unassigned', score: null, ignoredAt: 't' });
    await addFace('rejected', { person: null, status: 'unassigned', score: null });
    await run("INSERT INTO face_rejections (face_id, person_id) VALUES ('rejected', 'p1'), ('confirmed', 'p2')");
    await addFace('theirs', { photo: 'ph2' });
    const ids = ['confirmed', 'moved', 'open', 'ignored', 'rejected', 'theirs', 'deleted'];
    const snapshot = async () => JSON.stringify([
      (await env.DB.prepare('SELECT id, person_id, assign_status, match_score, ignored_at FROM faces ORDER BY id').all()).results,
      await rejections(),
    ]);
    const before = await snapshot();
    for (const body of [{ confirm: ids }, { reject: ids }]) {
      const res = await review(body);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ confirmed: [], rejected: [] });
    }
    expect(await snapshot()).toBe(before);
  });

  it('a confirmed face is not moved by a later match run', async () => {
    await addFace('mine', { score: 0.55 });
    await addFace('ref', { person: 'p2', status: 'confirmed' });
    await review({ confirm: ['mine'] });
    expect((await send('POST', '/people/p2/match', { apply: true })).status).toBe(200);
    expect(await row('mine')).toMatchObject({ person_id: 'p1', assign_status: 'confirmed' });
  });

  it.each([
    {},
    { confirm: [], reject: [] },
    { confirm: Array.from({ length: 101 }, (_, i) => `a${i}`), reject: Array.from({ length: 100 }, (_, i) => `b${i}`) },
    { confirm: ['a'], reject: ['a'] },
    { confirm: [''] },
  ])('rejects a bad body and changes nothing', async (body) => {
    await addFace('a');
    expect((await review(body)).status).toBe(400);
    expect(await row('a')).toMatchObject({ assign_status: 'auto', person_id: 'p1' });
  });

  it('accepts 200 ids', async () => {
    await addFace('a0');
    const res = await review({ confirm: Array.from({ length: 200 }, (_, i) => `a${i}`) });
    expect(await res.json()).toEqual({ confirmed: ['a0'], rejected: [] });
  });

  it('is for the person owner only', async () => {
    await addFace('a');
    expect((await review({ confirm: ['a'] }, VIEWER)).status).toBe(403);
    expect((await review({ confirm: ['a'] }, 'stranger@example.com')).status).toBe(404);
    expect(await row('a')).toMatchObject({ assign_status: 'auto' });
  });
});
