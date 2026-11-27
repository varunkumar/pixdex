import { env, SELF } from 'cloudflare:test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PERSON_REFERENCES_BACKFILL_SQL } from '../migrations/index';
import { embeddingToBytes } from '../src/people/embedding';
import { refreshReferences } from '../src/people/referenceSelection';
import { loadReferences } from '../src/people/references';
import { OWNER_TEST_EMAIL, readHeaders, restoreReferenceFixture, withoutReferenceFixture } from './helpers';

const OWNER = OWNER_TEST_EMAIL;
const run = (sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params).run();
const send = (method: string, path: string, body?: unknown) =>
  SELF.fetch(`https://example.com${path}`, {
    method,
    headers: { ...readHeaders(OWNER), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const vector = new Float32Array(512);
vector[0] = 1;
const embedding = embeddingToBytes(vector).buffer;

type Seed = { person?: string | null; status?: string; year?: number | null; size?: number; det?: number };
let photos = 0;
/** A face in its own photo, taken in `year` (null: undated), filling `size` x `size` of the frame. */
async function addFace(id: string, o: Seed = {}) {
  const photo = `ph${++photos}`;
  const year = o.year === undefined ? 2020 : o.year;
  await run(
    `INSERT INTO photos (id, content_hash, source, filename, album, date_time, subjects, model_provider, model_name, last_indexed)
     VALUES (?, ?, 'local', 'a.jpg', 'Kanha', ?, '[]', 'ollama', 'm', 'x')`,
    photo, `hash-spread-${photo}`, year === null ? null : `${year}-05-01T10:00:00`
  );
  await run(
    `INSERT INTO faces (id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, det_score, embedding, embedding_model, person_id, assign_status, match_score, created_at)
     VALUES (?, ?, 0.1, 0.1, ?, ?, ?, ?, 'buffalo_l', ?, ?, ?, 'x')`,
    id, photo, o.size ?? 0.2, o.size ?? 0.2, o.det ?? 0.9, embedding,
    o.person === undefined ? 'p1' : o.person, o.status ?? 'confirmed', o.status === 'auto' ? 0.6 : null
  );
}

const refs = async (person = 'p1') =>
  (await env.DB.prepare('SELECT face_id FROM person_references WHERE person_id = ? ORDER BY face_id').bind(person).all<{ face_id: string }>())
    .results.map((r) => r.face_id);
const recompute = (...personIds: string[]) => refreshReferences(env.DB, { personIds });
/** `count` faces of 2026 named a00.., all larger than the faces a test adds afterwards. */
const crowd = async (count: number, person = 'p1', prefix = 'a') => {
  for (let i = 0; i < count; i++) await addFace(`${prefix}${String(i).padStart(2, '0')}`, { person, year: 2026, size: 0.5 - i / 1000 });
};

beforeAll(withoutReferenceFixture);
afterAll(restoreReferenceFixture);
beforeEach(async () => {
  for (const t of ['person_references', 'face_rejections', 'faces', 'persons', 'photos']) await run(`DELETE FROM ${t}`);
  await run("INSERT INTO persons (id, name, owner_email, created_at) VALUES ('p1', 'Asha', ?, 'x'), ('p2', 'Bina', ?, 'x')", OWNER, OWNER);
});

describe('the selection', () => {
  it('uses every confirmed face of a person with 30 or fewer, and nothing else', async () => {
    await addFace('c1');
    await addFace('c2', { year: null });
    await addFace('auto', { status: 'auto' });
    await addFace('other', { person: 'p2' });
    await recompute('p1');
    expect(await refs()).toEqual(['c1', 'c2']);
    expect(await refs('p2')).toEqual([]);
  });

  it('gives every year and the undated faces their turns', async () => {
    await crowd(60);
    for (const [year, id] of [[1995, 'y1995'], [2008, 'y2008'], [null, 'undated']] as const) {
      await addFace(`${id}-1`, { year, size: 0.1 });
      await addFace(`${id}-2`, { year, size: 0.09 });
    }
    await recompute('p1');
    const chosen = await refs();
    expect(chosen).toHaveLength(30);
    expect(chosen.filter((id) => !id.startsWith('a'))).toEqual(['undated-1', 'undated-2', 'y1995-1', 'y1995-2', 'y2008-1', 'y2008-2']);
    // The remaining places go to the best faces of the crowded year.
    expect(chosen.filter((id) => id.startsWith('a'))).toEqual(Array.from({ length: 24 }, (_, i) => `a${String(i).padStart(2, '0')}`));
  });

  it('ranks a year by face size, then detection score', async () => {
    for (let i = 0; i < 29; i++) await addFace(`y${i}`, { year: 1900 + i });
    await addFace('small', { year: 2026, size: 0.1, det: 0.99 });
    await addFace('big-unsure', { year: 2026, size: 0.3, det: 0.8 });
    await addFace('big-sure', { year: 2026, size: 0.3, det: 0.95 });
    await recompute('p1');
    expect((await refs()).filter((id) => !id.startsWith('y'))).toEqual(['big-sure']);
  });

  it('writes nothing when the choice is unchanged', async () => {
    await crowd(40);
    await recompute('p1');
    expect(await recompute('p1')).toBe(0);
  });

  it('the migration backfill chooses the same faces as a recompute, for every person', async () => {
    await crowd(40);
    await addFace('old', { year: 1990, size: 0.06 });
    await crowd(5, 'p2', 'b');
    await env.DB.prepare(PERSON_REFERENCES_BACKFILL_SQL).run();
    const filled = [await refs('p1'), await refs('p2')];
    await run('DELETE FROM person_references');
    await recompute('p1', 'p2');
    expect([await refs('p1'), await refs('p2')]).toEqual(filled);
    expect(filled[0]).toContain('old');
  });
});

describe('loadReferences', () => {
  it('loads the stored faces only, and ignores a stale row', async () => {
    await addFace('kept');
    await addFace('unchosen');
    await addFace('moved', { person: 'p2' });
    await addFace('auto', { status: 'auto' });
    for (const id of ['kept', 'moved', 'auto', 'gone'])
      await run("INSERT INTO person_references (person_id, face_id) VALUES ('p1', ?)", id);
    expect((await loadReferences(env.DB, { personId: 'p1' })).map((r) => [r.personId, r.vectors.length])).toEqual([['p1', 1]]);
  });
});

describe('writes keep the references current', () => {
  it('a failed refresh does not fail the save, and Re-run matching repairs it', async () => {
    await addFace('f1', { person: null, status: 'unassigned' });
    await run('ALTER TABLE person_references RENAME TO person_references_away');
    try {
      expect((await send('POST', '/faces/f1/assign', { personId: 'p1' })).status).toBe(200);
    } finally {
      await run('ALTER TABLE person_references_away RENAME TO person_references');
    }
    expect(await refs()).toEqual([]);
    await send('POST', '/people/p1/match', { apply: true });
    expect(await refs()).toEqual(['f1']);
  });

  it('naming faces (create, bulk assign, single assign)', async () => {
    await addFace('f1', { person: null, status: 'unassigned' });
    await addFace('f2', { person: null, status: 'unassigned' });
    await addFace('f3', { person: null, status: 'unassigned' });
    const created = await (await send('POST', '/people', { name: 'New', faceIds: ['f1'] })).json<{ id: string }>();
    expect(await refs(created.id)).toEqual(['f1']);
    await send('POST', '/people/p1/faces', { faceIds: ['f2'] });
    await send('POST', '/faces/f3/assign', { personId: 'p1' });
    expect(await refs()).toEqual(['f2', 'f3']);
  });

  it('moving a reference to another person refills the place it left', async () => {
    await crowd(31);
    await recompute('p1');
    expect(await refs()).not.toContain('a30');
    await send('POST', '/faces/a00/assign', { personId: 'p2' });
    expect(await refs('p2')).toEqual(['a00']);
    expect(await refs()).toHaveLength(30);
    expect(await refs()).toContain('a30');
    expect(await refs()).not.toContain('a00');
  });

  it.each([
    ['Not X', () => send('POST', '/faces/a00/reject', { personId: 'p1' })],
    ['Remove name', () => send('POST', '/faces/a00/unassign', {})],
  ])('%s on a reference refills its place', async (_label, act) => {
    await crowd(31);
    await recompute('p1');
    expect((await act()).status).toBe(200);
    expect(await refs()).toEqual(Array.from({ length: 30 }, (_, i) => `a${String(i + 1).padStart(2, '0')}`));
  });

  it('"Not X" for a person the face does not belong to changes nothing', async () => {
    await addFace('f1');
    await recompute('p1');
    await send('POST', '/faces/f1/reject', { personId: 'p2' });
    expect(await refs()).toEqual(['f1']);
  });

  it('a review that confirms', async () => {
    await addFace('a1', { status: 'auto' });
    await addFace('a2', { status: 'auto' });
    const res = await send('POST', '/people/p1/auto-faces/review', { confirm: ['a1'], reject: ['a2'] });
    expect(await res.json()).toEqual({ confirmed: ['a1'], rejected: ['a2'] });
    expect(await refs()).toEqual(['a1']);
  });

  it('deleting a person removes their rows', async () => {
    await addFace('f1');
    await recompute('p1');
    expect((await send('DELETE', '/people/p1')).status).toBe(204);
    expect(await refs()).toEqual([]);
  });

  it('Re-run matching repairs the references first, but an automatic run does not', async () => {
    await addFace('f1');
    await send('POST', '/people/p1/match', { apply: true, from: [] });
    expect(await refs()).toEqual([]);
    await send('POST', '/people/p1/match', {});
    expect(await refs()).toEqual([]);
    await send('POST', '/people/p1/match', { apply: true });
    expect(await refs()).toEqual(['f1']);
  });
});
