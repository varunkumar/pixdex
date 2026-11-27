import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { readHeaders } from './helpers';

const HASH = '0123456789abcdef0123456789abcdef';
const KEY = `hero/${HASH}.jpg`;
const VIEWER = 'viewer@example.com';
const STRANGER = 'stranger@example.com';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 1, 2]);

const url = (hash: string) => `https://example.com/heroes/${hash}`;
const get = (hash: string, as?: string) => SELF.fetch(url(hash), { headers: readHeaders(as) });
const put = (hash: string, body: Uint8Array, as?: string) =>
  SELF.fetch(url(hash), { method: 'PUT', headers: { ...readHeaders(as), 'Content-Type': 'image/jpeg' }, body });

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM photos').run();
  await env.DB.prepare(
    `INSERT INTO photos (id, content_hash, source, filename, album, model_provider, model_name, last_indexed)
     VALUES ('hero1', ?, 'local', 'h.jpg', 'Heroes', 'ollama', 'm', '2026-01-01T00:00:00.000Z')`
  ).bind(HASH).run();
  await env.DB.prepare(`UPDATE albums SET shared_with = '["viewer@example.com"]' WHERE name = 'Heroes'`).run();
  await env.THUMBNAILS.delete(KEY);
});

describe('album hero images', () => {
  it('stores once and serves it', async () => {
    const missing = await get(HASH);
    expect(missing.status).toBe(404);
    await missing.arrayBuffer();

    expect((await put(HASH, JPEG)).status).toBe(201);

    const res = await get(HASH);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG);

    const viewer = await get(HASH, VIEWER);
    expect(viewer.status).toBe(200);
    await viewer.arrayBuffer();
  });

  it('never overwrites', async () => {
    expect((await put(HASH, JPEG)).status).toBe(201);
    expect((await put(HASH, new Uint8Array([0xff, 0xd8, 0xff, 9, 9, 9]))).status).toBe(200);
    expect(new Uint8Array(await (await get(HASH)).arrayBuffer())).toEqual(JPEG);
  });

  it('viewer 403, stranger 404, nothing stored', async () => {
    expect((await put(HASH, JPEG, VIEWER)).status).toBe(403);
    expect((await put(HASH, JPEG, STRANGER)).status).toBe(404);
    expect(await env.THUMBNAILS.head(KEY)).toBeNull();
  });

  it('stranger cannot read a stored hero', async () => {
    expect((await put(HASH, JPEG)).status).toBe(201);
    expect((await get(HASH, STRANGER)).status).toBe(404);
  });

  it('404 for a hash with no photo', async () => {
    const unknown = 'f'.repeat(32);
    expect((await put(unknown, JPEG)).status).toBe(404);
    expect(await env.THUMBNAILS.head(`hero/${unknown}.jpg`)).toBeNull();
  });

  it('rejects bad input', async () => {
    expect((await put('short', JPEG)).status).toBe(400);
    expect((await get('short')).status).toBe(400);
    expect((await put(HASH, new Uint8Array([1, 2, 3, 4]))).status).toBe(400);
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set([0xff, 0xd8, 0xff]);
    expect((await put(HASH, big)).status).toBe(413);
    expect(await env.THUMBNAILS.head(KEY)).toBeNull();
  });
});
