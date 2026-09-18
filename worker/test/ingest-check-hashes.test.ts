import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

async function seedPhoto(hash: string) {
  await env.DB.prepare(
    `INSERT INTO photos (id, content_hash, source, filename, model_provider, model_name, search_text, last_indexed)
     VALUES (?, ?, 'local', 'a.jpg', 'ollama', 'qwen3.5:27b-mlx', '', '2026-09-18T00:00:00.000Z')`
  )
    .bind(crypto.randomUUID(), hash)
    .run();
}

describe('POST /ingest/check-hashes', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM photos').run();
  });

  it('returns only the hashes that already exist', async () => {
    await seedPhoto('known-hash');

    const response = await SELF.fetch('https://example.com/ingest/check-hashes', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.INGEST_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes: ['known-hash', 'unknown-hash'] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ known: ['known-hash'] });
  });

  it('handles more than 100 hashes in one request by chunking the D1 query', async () => {
    const knownHashes = Array.from({ length: 120 }, (_, i) => `known-${i}`);
    for (const hash of knownHashes) {
      await seedPhoto(hash);
    }
    const unknownHashes = Array.from({ length: 30 }, (_, i) => `unknown-${i}`);

    const response = await SELF.fetch('https://example.com/ingest/check-hashes', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.INGEST_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes: [...knownHashes, ...unknownHashes] }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.known.sort()).toEqual(knownHashes.sort());
  });

  it('returns 400 (not 500) for a malformed JSON body', async () => {
    const response = await SELF.fetch('https://example.com/ingest/check-hashes', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.INGEST_TOKEN}`, 'Content-Type': 'application/json' },
      body: '{not valid json',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as any;
    expect(body.error).toBe('Invalid JSON body');
  });
});
