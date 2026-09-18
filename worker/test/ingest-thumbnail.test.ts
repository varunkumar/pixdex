import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('thumbnail upload + retrieval', () => {
  it('round-trips bytes through R2', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);

    const put = await SELF.fetch('https://example.com/ingest/thumbnail/hash-1', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${env.INGEST_TOKEN}`, 'Content-Type': 'image/jpeg' },
      body: bytes,
    });
    expect(put.status).toBe(201);

    const get = await SELF.fetch('https://example.com/thumbnails/hash-1');
    expect(get.status).toBe(200);
    expect(get.headers.get('Content-Type')).toBe('image/jpeg');
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
  });

  it('returns 404 for a missing thumbnail', async () => {
    const get = await SELF.fetch('https://example.com/thumbnails/does-not-exist');
    expect(get.status).toBe(404);
  });
});
