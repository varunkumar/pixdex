import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const VALID_HASH = '0123456789abcdef0123456789abcdef';

describe('thumbnail upload + retrieval', () => {
  it('round-trips bytes through R2', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);

    const put = await SELF.fetch(`https://example.com/ingest/thumbnail/${VALID_HASH}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${env.INGEST_TOKEN}`, 'Content-Type': 'image/jpeg' },
      body: bytes,
    });
    expect(put.status).toBe(201);

    const get = await SELF.fetch(`https://example.com/thumbnails/${VALID_HASH}`);
    expect(get.status).toBe(200);
    expect(get.headers.get('Content-Type')).toBe('image/jpeg');
    expect(get.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
  });

  it('returns 404 for a missing thumbnail', async () => {
    const get = await SELF.fetch('https://example.com/thumbnails/does-not-exist');
    expect(get.status).toBe(404);
  });

  it('rejects a contentHash that does not match the expected format', async () => {
    const put = await SELF.fetch('https://example.com/ingest/thumbnail/short', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${env.INGEST_TOKEN}`, 'Content-Type': 'image/jpeg' },
      body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(put.status).toBe(400);
  });

  it('rejects a body over the 2MB thumbnail size cap', async () => {
    const bytes = new Uint8Array(2 * 1024 * 1024 + 1);
    const put = await SELF.fetch(`https://example.com/ingest/thumbnail/${VALID_HASH}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${env.INGEST_TOKEN}`,
        'Content-Type': 'image/jpeg',
        'Content-Length': String(bytes.byteLength),
      },
      body: bytes,
    });
    expect(put.status).toBe(413);
  });
});
