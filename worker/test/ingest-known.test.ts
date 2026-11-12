import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { readHeaders } from './helpers';
import { EMBEDDING_WINDOW } from '../src/routes/ingest-known';

const post = (body: unknown, token: string = env.INGEST_TOKEN) =>
  SELF.fetch('https://example.com/ingest/known-people', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /ingest/known-people', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM known_people').run();
  });

  it('upserts twice with a changed name and leaves one row', async () => {
    const first = await post({ people: [{ id: 'Q1', name: 'Old Name', aliases: [] }] });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ upserted: 1 });
    await post({ people: [{ id: 'Q1', name: 'New Name', aliases: [] }] });
    const { results } = await env.DB.prepare('SELECT id, name FROM known_people').all();
    expect(results).toEqual([{ id: 'Q1', name: 'New Name' }]);
  });

  it('keeps created_at on update and stores aliases as JSON', async () => {
    await post({ people: [{ id: 'Q2', name: 'A', aliases: ['x', 'y'] }] });
    const a = await env.DB.prepare('SELECT aliases, created_at FROM known_people WHERE id = ?').bind('Q2').first<{ aliases: string; created_at: string }>();
    expect(JSON.parse(a!.aliases)).toEqual(['x', 'y']);
    await post({ people: [{ id: 'Q2', name: 'A', aliases: ['z'] }] });
    const b = await env.DB.prepare('SELECT aliases, created_at FROM known_people WHERE id = ?').bind('Q2').first<{ aliases: string; created_at: string }>();
    expect(JSON.parse(b!.aliases)).toEqual(['z']);
    expect(b!.created_at).toBe(a!.created_at);
  });

  it('upserts 500 people in one request', async () => {
    const people = Array.from({ length: 500 }, (_, i) => ({ id: `Q${i + 10}`, name: `P${i}`, aliases: [] }));
    expect(await (await post({ people })).json()).toEqual({ upserted: 500 });
  });

  it('rejects 501 people, empty list and bad fields with 400', async () => {
    const people = Array.from({ length: 501 }, (_, i) => ({ id: `Q${i}`, name: 'n', aliases: [] }));
    expect((await post({ people })).status).toBe(400);
    expect((await post({ people: [] })).status).toBe(400);
    expect((await post({ people: [{ id: 'Q1', name: '', aliases: [] }] })).status).toBe(400);
    expect((await post({ people: [{ id: 'Q1', name: 'n', aliases: Array(21).fill('a') }] })).status).toBe(400);
    expect((await post({ people: [{ id: 'Q1', name: 'n', aliases: ['a'.repeat(101)] }] })).status).toBe(400);
  });

  it('returns 400 for invalid JSON', async () => {
    const res = await SELF.fetch('https://example.com/ingest/known-people', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.INGEST_TOKEN}` },
      body: '{',
    });
    expect(res.status).toBe(400);
  });

  it('returns 401 with the read token or no token', async () => {
    expect((await post({ people: [{ id: 'Q1', name: 'n', aliases: [] }] }, env.READ_TOKEN)).status).toBe(401);
    const res = await SELF.fetch('https://example.com/ingest/known-people', { method: 'POST', headers: readHeaders(), body: '{}' });
    expect(res.status).toBe(401);
  });
});

const fid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function seedFace(n: number, model = 'arcface', knownId: string | null = null, fill = n) {
  await env.DB.prepare(
    `INSERT INTO faces (id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, det_score, embedding, embedding_model, known_id, created_at)
     VALUES (?, 'photo-e', 0.1, 0.1, 0.2, 0.2, 0.9, ?, ?, ?, '2026-01-01')`
  )
    .bind(fid(n), new Uint8Array(2048).fill(fill), model, knownId)
    .run();
}

const page = (body: unknown) =>
  SELF.fetch('https://example.com/ingest/faces/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.INGEST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const setKnown = (body: unknown, token: string = env.INGEST_TOKEN) =>
  SELF.fetch('https://example.com/ingest/faces/known', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /ingest/faces/embeddings', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM faces').run();
    await env.DB.prepare('DELETE FROM known_people').run();
  });

  it('returns id plus raw embedding bytes per face, with no cursor on the last page', async () => {
    for (const n of [1, 2, 3]) await seedFace(n);
    const res = await page({ model: 'arcface' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('X-Next-Cursor')).toBeNull();
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.length).toBe(3 * (36 + 2048));
    for (const [i, n] of [1, 2, 3].entries()) {
      const off = i * 2084;
      expect(new TextDecoder().decode(buf.subarray(off, off + 36))).toBe(fid(n));
      expect(buf.subarray(off + 36, off + 2084)).toEqual(new Uint8Array(2048).fill(n));
    }
  });

  it('excludes other models and skips known faces unless rescore', async () => {
    await seedFace(1);
    await seedFace(2, 'other');
    await env.DB.prepare("INSERT INTO known_people (id, name, aliases, created_at) VALUES ('Q1','A','[]','x')").run();
    await seedFace(3, 'arcface', 'Q1');
    const ids = async (body: unknown) => {
      const buf = new Uint8Array(await (await page(body)).arrayBuffer());
      return Array.from({ length: buf.length / 2084 }, (_, i) => new TextDecoder().decode(buf.subarray(i * 2084, i * 2084 + 36)));
    };
    expect(await ids({ model: 'arcface' })).toEqual([fid(1)]);
    expect(await ids({ model: 'arcface', rescore: true })).toEqual([fid(1), fid(3)]);
  });

  it('pages by rowid cursor and sets X-Next-Cursor on a full page', async () => {
    for (const n of [1, 2, 3]) await seedFace(n);
    const first = await page({ model: 'arcface', limit: 2 });
    const cursor = first.headers.get('X-Next-Cursor');
    expect(cursor).not.toBeNull();
    expect((await first.arrayBuffer()).byteLength).toBe(2 * 2084);
    const second = await page({ model: 'arcface', limit: 2, cursor: Number(cursor) });
    const b2 = new Uint8Array(await second.arrayBuffer());
    expect(b2.byteLength).toBe(2084);
    expect(new TextDecoder().decode(b2.subarray(0, 36))).toBe(fid(3));
    expect(second.headers.get('X-Next-Cursor')).toBeNull();
  });

  it('bounds the scanned rowid window: sparse data gives empty pages with a cursor that terminates', async () => {
    await seedFace(1);
    await env.DB.prepare(
      `INSERT INTO faces (rowid, id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, det_score, embedding, embedding_model, created_at)
       VALUES (?, ?, 'photo-e', 0.1, 0.1, 0.2, 0.2, 0.9, ?, 'arcface', '2026-01-01')`
    )
      .bind(3 * EMBEDDING_WINDOW - 1, fid(2), new Uint8Array(2048))
      .run();
    const sizes: number[] = [];
    let cursor = 0;
    for (let i = 0; i < 10; i++) {
      const res = await page({ model: 'arcface', cursor });
      sizes.push((await res.arrayBuffer()).byteLength);
      const next = res.headers.get('X-Next-Cursor');
      if (next === null) break;
      expect(Number(next)).toBeGreaterThan(cursor);
      expect(Number(next) - cursor).toBeLessThanOrEqual(EMBEDDING_WINDOW);
      cursor = Number(next);
    }
    expect(sizes).toEqual([2084, 0, 2084]);
  });

  it('skips null or wrong-length embeddings and still returns a cursor when the last row of a full page is skipped', async () => {
    await seedFace(1);
    await env.DB.prepare(
      `INSERT INTO faces (id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, det_score, embedding, embedding_model, created_at)
       VALUES (?, 'photo-e', 0.1, 0.1, 0.2, 0.2, 0.9, x'00', 'arcface', '2026-01-01')`
    )
      .bind(fid(2))
      .run();
    const res = await page({ model: 'arcface', limit: 2 });
    expect((await res.arrayBuffer()).byteLength).toBe(2084);
    expect(res.headers.get('X-Next-Cursor')).not.toBeNull();
  });

  it('rejects bad limits and invalid JSON, and requires the ingest token', async () => {
    expect((await page({ model: 'arcface', limit: 101 })).status).toBe(400);
    expect((await page({ model: 'arcface', limit: 0 })).status).toBe(400);
    expect((await page({})).status).toBe(400);
    const bad = await SELF.fetch('https://example.com/ingest/faces/embeddings', { method: 'POST', headers: { Authorization: `Bearer ${env.INGEST_TOKEN}` }, body: '{' });
    expect(bad.status).toBe(400);
    const res = await SELF.fetch('https://example.com/ingest/faces/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.READ_TOKEN}` },
      body: JSON.stringify({ model: 'arcface' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /ingest/faces/known', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM faces').run();
    await env.DB.prepare('DELETE FROM known_people').run();
    await env.DB.prepare("INSERT INTO known_people (id, name, aliases, created_at) VALUES ('Q1','A','[]','x')").run();
    for (const n of [1, 2]) await seedFace(n);
  });
  const row = (n: number) => env.DB.prepare('SELECT known_id, known_score FROM faces WHERE id = ?').bind(fid(n)).first();

  it('sets matches and clears with null', async () => {
    const res = await setKnown({ matches: [{ faceId: fid(1), knownId: 'Q1', score: 0.8 }, { faceId: fid(2), knownId: 'Q1' }] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 2 });
    expect(await row(1)).toEqual({ known_id: 'Q1', known_score: 0.8 });
    expect(await row(2)).toEqual({ known_id: 'Q1', known_score: null });
    await setKnown({ matches: [{ faceId: fid(1), knownId: null }] });
    expect(await row(1)).toEqual({ known_id: null, known_score: null });
  });

  it('writes only rows that change (updated means changed)', async () => {
    const m = (knownId: string | null, score?: number) => ({ matches: [{ faceId: fid(1), knownId, score }] });
    const updated = async (body: unknown) => ((await (await setKnown(body)).json()) as { updated: number }).updated;
    expect(await updated(m(null))).toBe(0); // clearing an already-NULL face
    expect(await updated(m('Q1', 0.8))).toBe(1);
    expect(await updated(m('Q1', 0.8))).toBe(0); // same match again
    expect(await updated(m('Q1', 0.9))).toBe(1); // changed score
    expect(await updated(m('Q1'))).toBe(1); // score dropped to null
    expect(await updated(m('Q1'))).toBe(0);
    await env.DB.prepare("INSERT INTO known_people (id, name, aliases, created_at) VALUES ('Q2','B','[]','x')").run();
    expect(await updated(m('Q2'))).toBe(1); // changed id
    expect(await updated(m(null))).toBe(1); // null clear of a matched face
    expect(await row(1)).toEqual({ known_id: null, known_score: null });
  });

  it('keeps person_id and assign_status, and the last duplicate faceId wins', async () => {
    await env.DB.prepare("UPDATE faces SET person_id = 'p1', assign_status = 'confirmed' WHERE id = ?").bind(fid(1)).run();
    const res = await setKnown({ matches: [{ faceId: fid(1), knownId: 'Q1', score: 0.5 }, { faceId: fid(1), knownId: null }] });
    expect(await res.json()).toEqual({ updated: 0 }); // the last entry clears an already-NULL face: no change
    expect(await row(1)).toEqual({ known_id: null, known_score: null });
    const f = await env.DB.prepare('SELECT person_id, assign_status FROM faces WHERE id = ?').bind(fid(1)).first();
    expect(f).toEqual({ person_id: 'p1', assign_status: 'confirmed' });
  });

  it('returns 400 and changes nothing when a knownId does not exist', async () => {
    const res = await setKnown({ matches: [{ faceId: fid(1), knownId: 'Q1', score: 0.9 }, { faceId: fid(2), knownId: 'Q999' }] });
    expect(res.status).toBe(400);
    expect(await row(1)).toEqual({ known_id: null, known_score: null });
  });

  it('rejects 0 and 201 matches and the wrong token', async () => {
    const m = (n: number) => Array.from({ length: n }, () => ({ faceId: fid(1), knownId: null }));
    expect((await setKnown({ matches: m(201) })).status).toBe(400);
    expect((await setKnown({ matches: [] })).status).toBe(400);
    expect((await setKnown({ matches: m(200) })).status).toBe(200);
    expect((await setKnown({ matches: m(1) }, env.READ_TOKEN)).status).toBe(401);
  });
});
