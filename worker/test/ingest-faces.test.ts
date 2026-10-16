import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { embeddingFromBytes } from '../src/people/embedding';

const photo = {
  id: '123e4567-e89b-12d3-a456-426614174000',
  contentHash: 'hash-faces',
  source: 'local' as const,
  filename: 'group.jpg',
  subjects: ['people'],
  tags: ['people'],
  description: 'A group photo.',
  modelProvider: 'ollama',
  modelName: 'qwen',
};
const MODEL = 'buffalo_l';

const ingestHeaders = () => ({ Authorization: `Bearer ${env.INGEST_TOKEN}`, 'Content-Type': 'application/json' });

/** Base64 of 512 little-endian float32s: a one-hot-ish vector so it is non-zero. */
function embedding(seed = 1): string {
  const bytes = new Uint8Array(512 * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < 512; i++) view.setFloat32(i * 4, i === seed % 512 ? 1 : 0.01, true);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const face = (x = 0.1, seed = 1, w = 0.2, h = 0.2) => ({
  bbox: { x, y: 0.1, w, h },
  detScore: 0.9,
  embedding: embedding(seed),
});

const post = (path: string, body: unknown, headers: Record<string, string> = ingestHeaders()) =>
  SELF.fetch(`https://example.com/ingest/faces${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

async function addPhoto() {
  const res = await SELF.fetch('https://example.com/ingest/photo', {
    method: 'POST',
    headers: ingestHeaders(),
    body: JSON.stringify(photo),
  });
  expect(res.status).toBe(201);
}

const faceRows = () =>
  env.DB.prepare('SELECT * FROM faces WHERE photo_id = ? ORDER BY bbox_x').bind(photo.id).all<any>();

describe('face ingest routes', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM faces').run();
    await env.DB.prepare('DELETE FROM photos').run();
    await addPhoto();
  });

  it('rejects a missing or wrong ingest token', async () => {
    const body = { hashes: [photo.contentHash], model: MODEL };
    expect((await post('/pending', body, {})).status).toBe(401);
    expect((await post('/pending', body, { Authorization: 'Bearer wrong' })).status).toBe(401);
    const stored = { contentHash: photo.contentHash, model: MODEL, faces: [] };
    expect((await post('', stored, {})).status).toBe(401);
  });

  describe('unscanned', () => {
    const addLocal = async (n: number, path: string | undefined, source: 'local' | 'google_drive' = 'local') => {
      const res = await SELF.fetch('https://example.com/ingest/photo', {
        method: 'POST',
        headers: ingestHeaders(),
        body: JSON.stringify({
          ...photo,
          id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
          contentHash: `unscanned-${n}`,
          filename: `p${n}.jpg`,
          source,
          ...(path ? { path } : {}),
          ...(source === 'google_drive' ? { driveFileId: `drive-${n}` } : {}),
        }),
      });
      expect(res.status).toBe(201);
    };

    beforeEach(async () => {
      await env.DB.prepare('DELETE FROM photos').run();
    });

    it('lists unscanned local photos with their paths and skips scanned, drive and path-less ones', async () => {
      await addLocal(1, '/Volumes/T9/A/Processed/1.jpg');
      await addLocal(2, '/Volumes/T9/A/Processed/2.jpg');
      await addLocal(3, '/Volumes/T9/B/Processed/3.jpg');
      await addLocal(4, undefined);
      await addLocal(5, undefined, 'google_drive');
      await post('', { contentHash: 'unscanned-2', model: MODEL, faces: [] });

      const res = await post('/unscanned', { model: MODEL });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: { contentHash: string; path: string }[]; nextCursor: number | null };
      expect(body.items.map((i) => i.contentHash)).toEqual(['unscanned-1', 'unscanned-3']);
      expect(body.items[0].path).toBe('/Volumes/T9/A/Processed/1.jpg');
      expect(body.nextCursor).toBeNull();
    });

    it('treats a photo scanned with a different model as unscanned', async () => {
      await addLocal(1, '/x/1.jpg');
      await post('', { contentHash: 'unscanned-1', model: 'old_model', faces: [] });
      const body = (await (await post('/unscanned', { model: MODEL })).json()) as { items: unknown[] };
      expect(body.items).toHaveLength(1);
    });

    it('pages with a cursor and filters by path prefix without treating % or _ as wildcards', async () => {
      for (let i = 1; i <= 5; i++) await addLocal(i, `/Volumes/T9/A_1/${i}.jpg`);
      await addLocal(6, '/Volumes/T9/AX1/6.jpg');
      await addLocal(7, '/Volumes/T9/B/7.jpg');

      const first = (await (await post('/unscanned', { model: MODEL, limit: 2, pathPrefix: '/Volumes/T9/A_1/' })).json()) as any;
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      const second = (await (await post('/unscanned', { model: MODEL, limit: 10, cursor: first.nextCursor, pathPrefix: '/Volumes/T9/A_1/' })).json()) as any;
      expect(second.items.map((i: any) => i.contentHash)).toEqual(['unscanned-3', 'unscanned-4', 'unscanned-5']);
      expect(second.nextCursor).toBeNull();
    });

    it('requires the ingest token and a model', async () => {
      expect((await post('/unscanned', { model: MODEL }, {})).status).toBe(401);
      expect((await post('/unscanned', {})).status).toBe(400);
    });
  });

  it('pending lists only indexed, unscanned hashes', async () => {
    await SELF.fetch('https://example.com/ingest/photo', {
      method: 'POST',
      headers: ingestHeaders(),
      body: JSON.stringify({ ...photo, id: '223e4567-e89b-12d3-a456-426614174000', contentHash: 'hash-scanned' }),
    });
    await env.DB.prepare('UPDATE photos SET faces_scanned_model = ? WHERE content_hash = ?')
      .bind(MODEL, 'hash-scanned')
      .run();
    await env.DB.prepare('UPDATE photos SET faces_scanned_model = ? WHERE content_hash = ?')
      .bind('older', photo.contentHash)
      .run();

    const res = await post('/pending', { hashes: [photo.contentHash, 'hash-scanned', 'unknown'], model: MODEL });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pending: [photo.contentHash] });
  });

  it('stores faces unassigned and marks the photo scanned', async () => {
    const res = await post('', { contentHash: photo.contentHash, model: MODEL, faces: [face(0.1, 1), face(0.6, 2)] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stored: 2, kept: 0, matched: 0, skipped: 0 });

    const { results } = await faceRows();
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      bbox_x: 0.1,
      det_score: 0.9,
      embedding_model: MODEL,
      person_id: null,
      assign_status: 'unassigned',
      match_score: null,
    });
    const scanned = await env.DB.prepare('SELECT faces_scanned_model m FROM photos WHERE id = ?')
      .bind(photo.id)
      .first<{ m: string }>();
    expect(scanned?.m).toBe(MODEL);
  });

  it('stores the embedding as a BLOB that decodes back', async () => {
    await post('', { contentHash: photo.contentHash, model: MODEL, faces: [face(0.1, 7)] });
    const row = await env.DB.prepare('SELECT embedding, typeof(embedding) t FROM faces WHERE photo_id = ?')
      .bind(photo.id)
      .first<{ embedding: ArrayBuffer | number[]; t: string }>();
    expect(row?.t).toBe('blob');
    const raw = row!.embedding;
    const v = embeddingFromBytes(raw instanceof ArrayBuffer ? raw : new Uint8Array(raw));
    expect(v).toHaveLength(512);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 4);
    expect(v[7]).toBeGreaterThan(v[8]);
  });

  it('a photo with no faces is marked scanned and no longer pending', async () => {
    const res = await post('', { contentHash: photo.contentHash, model: MODEL, faces: [] });
    expect(await res.json()).toEqual({ stored: 0, kept: 0, matched: 0, skipped: 0 });
    const pending = await post('/pending', { hashes: [photo.contentHash], model: MODEL });
    expect(await pending.json()).toEqual({ pending: [] });
  });

  it('re-ingest replaces unassigned and auto faces', async () => {
    await post('', { contentHash: photo.contentHash, model: MODEL, faces: [face(0.1, 1), face(0.6, 2)] });
    await env.DB.prepare("UPDATE faces SET assign_status = 'auto', match_score = 0.7 WHERE bbox_x = 0.6").run();

    const res = await post('', { contentHash: photo.contentHash, model: MODEL, faces: [face(0.3, 3)] });
    expect(await res.json()).toEqual({ stored: 1, kept: 0, matched: 0, skipped: 0 });
    const { results } = await faceRows();
    expect(results).toHaveLength(1);
    expect(results[0].bbox_x).toBe(0.3);
    expect(results[0].assign_status).toBe('unassigned');
  });

  it('re-ingest keeps a confirmed face and does not duplicate it', async () => {
    await post('', { contentHash: photo.contentHash, model: MODEL, faces: [face(0.1, 1), face(0.6, 2)] });
    await env.DB.prepare(
      "UPDATE faces SET assign_status = 'confirmed', person_id = 'p1' WHERE bbox_x = 0.1"
    ).run();

    // 0.12 overlaps the confirmed box heavily (IoU > 0.5); 0.7 is elsewhere.
    const res = await post('', {
      contentHash: photo.contentHash,
      model: MODEL,
      faces: [face(0.12, 1), face(0.7, 4)],
    });
    expect(await res.json()).toEqual({ stored: 1, kept: 1, matched: 0, skipped: 0 });
    const { results } = await faceRows();
    expect(results.map((r: any) => r.bbox_x)).toEqual([0.1, 0.7]);
    expect(results[0]).toMatchObject({ assign_status: 'confirmed', person_id: 'p1' });
  });

  it('ignores person_id or assign_status sent in the body', async () => {
    const sneaky = { ...face(0.1, 1), person_id: 'p1', personId: 'p1', assign_status: 'confirmed', assignStatus: 'confirmed' };
    const res = await post('', { contentHash: photo.contentHash, model: MODEL, faces: [sneaky] });
    expect(res.status).toBe(200);
    const { results } = await faceRows();
    expect(results[0].person_id).toBeNull();
    expect(results[0].assign_status).toBe('unassigned');
  });

  it('400 for an embedding of the wrong length', async () => {
    const bad = { ...face(), embedding: btoa('too short') };
    const res = await post('', { contentHash: photo.contentHash, model: MODEL, faces: [bad] });
    expect(res.status).toBe(400);
    expect((await faceRows()).results).toHaveLength(0);
  });

  it('400 for a malformed body', async () => {
    expect((await post('', { contentHash: photo.contentHash })).status).toBe(400);
    expect((await post('/pending', { hashes: 'x' })).status).toBe(400);
  });

  it('404 for an unknown content hash', async () => {
    const res = await post('', { contentHash: 'nope', model: MODEL, faces: [face()] });
    expect(res.status).toBe(404);
  });

  it('rejects more than 10 faces in one request', async () => {
    const faces = Array.from({ length: 11 }, (_, i) => face(0.1, i + 1));
    const res = await post('', { contentHash: photo.contentHash, model: MODEL, faces });
    expect(res.status).toBe(400);
  });
});
