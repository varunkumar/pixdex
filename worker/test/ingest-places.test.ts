import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { readHeaders } from './helpers';
import { clearInsights, getJson, seedPhoto } from './insights-helpers';

const ingestHeaders = () => ({ Authorization: `Bearer ${env.INGEST_TOKEN}`, 'Content-Type': 'application/json' });

async function post(path: string, body: unknown, headers: Record<string, string> = ingestHeaders()) {
  const r = await SELF.fetch(`https://example.com${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, body: r.status < 300 ? ((await r.json()) as any) : null };
}
const placeOf = async (id: string) => (await env.DB.prepare('SELECT place FROM photos WHERE id = ?').bind(id).first<{ place: string | null }>())!.place;
const gps = { latitude: 11.67, longitude: 76.63 };

const ingest = {
  id: '123e4567-e89b-12d3-a456-426614174009',
  contentHash: 'hash-place',
  source: 'local',
  filename: 'tiger.jpg',
  album: 'Tigers',
  subjects: ['tiger'],
  tags: [],
  description: 'A tiger.',
  modelProvider: 'ollama',
  modelName: 'qwen',
  ownerEmail: 'owner@example.com',
};

describe('photo places', () => {
  beforeEach(clearInsights);

  it('pages through photos with GPS and no place', async () => {
    await seedPhoto({ id: 'g1', ...gps });
    await seedPhoto({ id: 'none' });
    await seedPhoto({ id: 'g2', ...gps });
    await seedPhoto({ id: 'done', ...gps, place: 'Town, IN' });
    await seedPhoto({ id: 'g3', ...gps });
    const first = await post('/ingest/places/pending', { limit: 2 });
    expect(first.status).toBe(200);
    expect(first.body.items).toEqual([
      { contentHash: 'h-g1', ...gps },
      { contentHash: 'h-g2', ...gps },
    ]);
    const second = await post('/ingest/places/pending', { limit: 2, cursor: first.body.nextCursor });
    expect(second.body).toEqual({ items: [{ contentHash: 'h-g3', ...gps }], nextCursor: null });
  });

  it('stores places by content hash; an empty place is not pending again', async () => {
    await seedPhoto({ id: 'g1', ...gps });
    await seedPhoto({ id: 'g2', ...gps });
    const res = await post('/ingest/places', {
      photos: [
        { contentHash: 'h-g1', place: 'Gundlupet, IN' },
        { contentHash: 'h-g2', place: '' },
        { contentHash: 'gone', place: 'X, IN' },
      ],
    });
    expect(res.body).toEqual({ updated: 2, unknown: 1 });
    expect([await placeOf('g1'), await placeOf('g2')]).toEqual(['Gundlupet, IN', '']);
    expect((await post('/ingest/places/pending', { limit: 10 })).body.items).toEqual([]);
  });

  it('limits a request and needs the ingest token', async () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ contentHash: `h${i}`, place: 'X' }));
    expect((await post('/ingest/places', { photos: many })).status).toBe(400);
    expect((await post('/ingest/places', { photos: [{ contentHash: 'h', place: 'x'.repeat(121) }] })).status).toBe(400);
    expect((await post('/ingest/places/pending', { limit: 101 })).status).toBe(400);
    const read = { ...readHeaders(), 'Content-Type': 'application/json' };
    expect((await post('/ingest/places/pending', { limit: 1 }, read)).status).toBe(401);
  });

  it('clears the place when an EXIF update moves the GPS position', async () => {
    await seedPhoto({ id: 'g1', ...gps, place: 'Gundlupet, IN' });
    await post('/ingest/exif', { contentHash: 'h-g1', ...gps });
    expect(await placeOf('g1')).toBe('Gundlupet, IN');
    await post('/ingest/exif', { contentHash: 'h-g1', latitude: 12.3, longitude: 76.6 });
    expect(await placeOf('g1')).toBeNull();
  });

  it('takes a place at ingest and keeps it on a re-index only for the same position', async () => {
    expect((await post('/ingest/photo', { ...ingest, ...gps, place: 'Gundlupet, IN' })).status).toBe(201);
    expect(await placeOf(ingest.id)).toBe('Gundlupet, IN');
    await post('/ingest/photo', { ...ingest, ...gps });
    expect(await placeOf(ingest.id)).toBe('Gundlupet, IN');
    await post('/ingest/photo', { ...ingest, latitude: 12.3, longitude: 76.6 });
    expect(await placeOf(ingest.id)).toBeNull();
  });

  it('does not make the place searchable', async () => {
    await post('/ingest/photo', { ...ingest, ...gps, place: 'Gundlupet, IN' });
    expect((await getJson('/search?q=gundlupet')).body.results).toEqual([]);
  });
});
