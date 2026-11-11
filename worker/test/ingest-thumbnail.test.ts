import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { readHeaders } from './helpers';

const VALID_HASH = '0123456789abcdef0123456789abcdef';

describe('thumbnail upload + retrieval', () => {
  it('round-trips bytes through R2', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await env.DB.prepare(
      `INSERT OR REPLACE INTO photos (id, content_hash, source, filename, album, model_provider, model_name, last_indexed)
       VALUES ('thumb1', ?, 'local', 't.jpg', 'Thumbs', 'ollama', 'm', '2026-01-01T00:00:00.000Z')`
    ).bind(VALID_HASH).run();

    const put = await SELF.fetch(`https://example.com/ingest/thumbnail/${VALID_HASH}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${env.INGEST_TOKEN}`, 'Content-Type': 'image/jpeg' },
      body: bytes,
    });
    expect(put.status).toBe(201);
    const get = await SELF.fetch(`https://example.com/thumbnails/${VALID_HASH}`, {
      headers: readHeaders(),
    });
    expect(get.status).toBe(200);
    expect(get.headers.get('Content-Type')).toBe('image/jpeg');
    expect(get.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);

    // Visibility gates the bytes: someone with no access to the album gets 404 and the object is not read.
    const stranger = await SELF.fetch(`https://example.com/thumbnails/${VALID_HASH}`, { headers: readHeaders('stranger@example.com') });
    expect(stranger.status).toBe(404);
  });

  it('returns 404 for a missing thumbnail', async () => {
    const get = await SELF.fetch('https://example.com/thumbnails/does-not-exist', {
      headers: readHeaders(),
    });
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
