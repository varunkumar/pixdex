import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

const base = {
  id: '123e4567-e89b-12d3-a456-426614174000',
  contentHash: 'hash-exif',
  source: 'local' as const,
  filename: 'tiger.jpg',
  subjects: ['tiger'],
  tags: ['tiger'],
  description: 'A tiger on a rock.',
  modelProvider: 'ollama',
  modelName: 'qwen',
};

const exif = {
  cameraMake: 'NIKON CORPORATION',
  cameraModel: 'NIKON Z 8',
  lensModel: 'VR 200-500mm f/5.6E',
  focalLength: 500,
  fNumber: 5.6,
  exposureTime: 0.004,
  iso: 2500,
};

const ingestHeaders = () => ({ Authorization: `Bearer ${env.INGEST_TOKEN}`, 'Content-Type': 'application/json' });
const readHeaders = () => ({ Authorization: `Bearer ${env.READ_TOKEN}` });

async function getPhoto(id: string) {
  const res = await SELF.fetch(`https://example.com/photos/${id}`, { headers: readHeaders() });
  return (await res.json()) as any;
}

describe('camera EXIF fields', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM photos').run();
  });

  it('stores EXIF on ingest, returns it, and makes camera and lens searchable', async () => {
    const res = await SELF.fetch('https://example.com/ingest/photo', {
      method: 'POST',
      headers: ingestHeaders(),
      body: JSON.stringify({ ...base, ...exif, latitude: 11.67, longitude: 76.63 }),
    });
    expect(res.status).toBe(201);

    const photo = await getPhoto(base.id);
    expect(photo).toMatchObject({ ...exif, latitude: 11.67, longitude: 76.63 });

    const search = await SELF.fetch('https://example.com/search?q=Z8', { headers: readHeaders() });
    // "Z 8" is two tokens; the lens name is a single searchable phrase.
    const lens = await SELF.fetch('https://example.com/search?q=200-500mm', { headers: readHeaders() });
    expect(search.status).toBe(200);
    expect(((await lens.json()) as any).results.map((r: { id: string }) => r.id)).toEqual([base.id]);
  });

  it('returns null EXIF fields for photos without them', async () => {
    await SELF.fetch('https://example.com/ingest/photo', {
      method: 'POST',
      headers: ingestHeaders(),
      body: JSON.stringify(base),
    });
    const photo = await getPhoto(base.id);
    expect(photo.cameraModel).toBeNull();
    expect(photo.iso).toBeNull();
    expect(photo.latitude).toBeNull();
  });

  it('backfills EXIF onto an existing photo by content hash, idempotently', async () => {
    await SELF.fetch('https://example.com/ingest/photo', {
      method: 'POST',
      headers: ingestHeaders(),
      body: JSON.stringify(base),
    });

    for (let i = 0; i < 2; i++) {
      const res = await SELF.fetch('https://example.com/ingest/exif', {
        method: 'POST',
        headers: ingestHeaders(),
        body: JSON.stringify({ contentHash: base.contentHash, ...exif }),
      });
      expect(res.status).toBe(200);
    }

    expect(await getPhoto(base.id)).toMatchObject(exif);
    const row = await env.DB.prepare('SELECT search_text FROM photos WHERE id = ?')
      .bind(base.id)
      .first<{ search_text: string }>();
    expect(row?.search_text.split('NIKON Z 8').length - 1).toBe(1);
  });

  it('404s for an unknown content hash and requires the ingest token', async () => {
    const unknown = await SELF.fetch('https://example.com/ingest/exif', {
      method: 'POST',
      headers: ingestHeaders(),
      body: JSON.stringify({ contentHash: 'nope', ...exif }),
    });
    expect(unknown.status).toBe(404);

    const noAuth = await SELF.fetch('https://example.com/ingest/exif', {
      method: 'POST',
      body: JSON.stringify({ contentHash: 'nope' }),
    });
    expect(noAuth.status).toBe(401);
  });

  describe('watermark flag', () => {
    const post = (body: object) =>
      SELF.fetch('https://example.com/ingest/photo', {
        method: 'POST',
        headers: ingestHeaders(),
        body: JSON.stringify(body),
      });

    it('stores true and false, and returns null when unknown', async () => {
      await post({ ...base, hasWatermark: true });
      expect((await getPhoto(base.id)).hasWatermark).toBe(true);

      await post({ ...base, hasWatermark: false });
      expect((await getPhoto(base.id)).hasWatermark).toBe(false);

      await env.DB.prepare('DELETE FROM photos').run();
      await post(base);
      expect((await getPhoto(base.id)).hasWatermark).toBeNull();
    });

    it('rejects a non-boolean flag', async () => {
      const res = await post({ ...base, hasWatermark: 'maybe' });
      expect(res.status).toBe(400);
    });
  });
});
