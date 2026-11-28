import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { peopleFacts } from '../src/insights/people';
import { clearInsights, getJson, seedPhoto } from './insights-helpers';

const OWNER = 'owner@example.com';
const TODAY = '2026-11-28';
const run = () => peopleFacts(env.DB, OWNER, TODAY);
const fact = async (id: string) => (await run()).find((f) => f.id === id)?.data as any;
let n = 0;

async function person(id: string, owner = OWNER): Promise<void> {
  await env.DB.prepare('INSERT INTO persons (id, name, created_at, owner_email) VALUES (?, ?, ?, ?)')
    .bind(id, `Name ${id}`, '2026-01-01T00:00:00Z', owner)
    .run();
}

async function face(photo: string, personId: string, status = 'confirmed', ignored: string | null = null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO faces (id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, det_score, embedding, embedding_model, person_id, assign_status, created_at, ignored_at)
     VALUES (?, ?, 0.1, 0.1, 0.2, 0.2, 0.9, x'00', 'm', ?, ?, '2026-01-01T00:00:00Z', ?)`
  )
    .bind(`face${++n}`, photo, personId, status, ignored)
    .run();
}

/** `count` photos, each showing all of `people`. */
async function together(count: number, people: string[], dt = '2026-06-01T06:00:00.000Z', album = 'A'): Promise<void> {
  for (let i = 0; i < count; i++) {
    const photo = await seedPhoto({ dt, album });
    for (const p of people) await face(photo, p);
  }
}

describe('people facts', () => {
  beforeEach(async () => {
    await clearInsights();
    for (const id of ['a', 'b', 'c', 'd']) await person(id);
  });

  it('needs a pair with 10 shared photos', async () => {
    await together(9, ['a', 'b']);
    expect(await fact('together')).toBeUndefined();
    await together(1, ['a', 'b']);
    expect(await fact('together')).toEqual({ pairs: [{ a: 'a', b: 'b', photos: 10 }] });
  });

  it('lists the top 3 pairs and counts a photo once', async () => {
    await together(13, ['a', 'b']);
    await together(12, ['a', 'c']);
    await together(11, ['b', 'd']);
    await together(10, ['c', 'd']);
    const photo = await seedPhoto({ dt: '2026-06-01T06:00:00.000Z' });
    for (const p of ['a', 'a', 'b']) await face(photo, p);
    expect((await fact('together')).pairs).toEqual([
      { a: 'a', b: 'b', photos: 14 },
      { a: 'a', b: 'c', photos: 12 },
      { a: 'b', b: 'd', photos: 11 },
    ]);
  });

  it('skips ignored and unassigned faces, other owners and shared albums', async () => {
    await person('x', 'other@example.com');
    await together(10, ['a', 'x']);
    await together(10, ['a', 'b'], '2026-06-01T06:00:00.000Z', 'Theirs');
    await env.DB.prepare(`UPDATE albums SET owner_email = 'other@example.com' WHERE name = 'Theirs'`).run();
    for (let i = 0; i < 10; i++) {
      const photo = await seedPhoto({ dt: '2026-06-01T06:00:00.000Z' });
      await face(photo, 'c');
      await face(photo, 'd', 'confirmed', '2026-01-01T00:00:00Z');
      await face(photo, 'b', 'unassigned');
    }
    expect(await fact('together')).toBeUndefined();
  });

  it('names the person not photographed the longest, from 20 photos and over a year', async () => {
    await together(19, ['a'], '2020-01-05T06:00:00.000Z');
    await together(20, ['b'], '2025-11-28T06:00:00.000Z'); // exactly 365 days: not yet
    expect(await fact('missed')).toBeUndefined();
    await together(20, ['c'], '2025-11-26T06:00:00.000Z');
    await together(20, ['d'], '2023-03-01T06:00:00.000Z');
    expect(await fact('missed')).toEqual({ person: 'd', lastDate: '2023-03-01', photos: 20 });
  });

  it('shows current names and drops deleted people from a cached answer', async () => {
    await together(20, ['a', 'b'], '2020-01-05T06:00:00.000Z');
    await together(10, ['c', 'd'], '2026-06-01T06:00:00.000Z');
    const first = (await getJson('/insights/people')).body.facts;
    expect(first[0]).toEqual({
      id: 'together',
      data: {
        pairs: [
          { a: { id: 'a', name: 'Name a' }, b: { id: 'b', name: 'Name b' }, photos: 20 },
          { a: { id: 'c', name: 'Name c' }, b: { id: 'd', name: 'Name d' }, photos: 10 },
        ],
      },
    });
    expect(first[1].data.person).toEqual({ id: 'a', name: 'Name a' });
    await env.DB.prepare(`UPDATE persons SET name = 'Renamed' WHERE id = 'c'`).run();
    await env.DB.prepare(`DELETE FROM persons WHERE id = 'a'`).run();
    const next = (await getJson('/insights/people')).body.facts;
    expect(next).toEqual([
      { id: 'together', data: { pairs: [{ a: { id: 'c', name: 'Renamed' }, b: { id: 'd', name: 'Name d' }, photos: 10 }] } },
    ]);
  });

  it('answers a viewer of a shared album with no facts and no names', async () => {
    await together(25, ['a', 'b'], '2020-01-05T06:00:00.000Z');
    await env.DB.prepare(`UPDATE albums SET shared_with = '["friend@example.com"]' WHERE name = 'A'`).run();
    expect((await getJson('/insights/people', 'friend@example.com')).body.facts).toEqual([]);
  });
});
