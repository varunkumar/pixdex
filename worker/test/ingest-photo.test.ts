import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

const payload = {
  id: '123e4567-e89b-12d3-a456-426614174000',
  contentHash: 'hash-1',
  source: 'local' as const,
  path: '/Users/me/Photos/leopard.jpg',
  filename: 'leopard.jpg',
  dateTime: '2026-01-05T10:00:00.000Z',
  width: 4000,
  height: 3000,
  format: 'jpeg',
  fileSize: 5_000_000,
  subjects: ['leopard'],
  colors: ['gold', 'green'],
  patterns: ['spots'],
  tags: ['leopard', 'big cat', 'tree'],
  season: 'winter',
  environment: 'dense forest',
  album: 'Kanha 2026',
  description: 'A leopard resting on a tree branch at dusk.',
  suggestedCaption: 'Golden hour, golden coat. 🐆',
  suggestedHashtags: ['leopard', 'wildlife', 'kanha'],
  modelProvider: 'ollama',
  modelName: 'qwen3.5:27b-mlx',
};

describe('POST /ingest/photo', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM photos').run();
  });

  it('inserts a photo row that is immediately searchable', async () => {
    const response = await SELF.fetch('https://example.com/ingest/photo', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.INGEST_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(201);

    const row = await env.DB.prepare('SELECT * FROM photos WHERE id = ?').bind('123e4567-e89b-12d3-a456-426614174000').first();
    expect(row?.filename).toBe('leopard.jpg');
    expect(row?.model_name).toBe('qwen3.5:27b-mlx');

    const match = await env.DB.prepare(
      `SELECT photos.id FROM photos JOIN photos_fts ON photos.rowid = photos_fts.rowid WHERE photos_fts MATCH 'leopard'`
    ).all();
    expect(match.results.map((r) => r.id)).toEqual(['123e4567-e89b-12d3-a456-426614174000']);
  });
});
