import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('photos schema', () => {
  it('accepts an insert and is searchable via photos_fts', async () => {
    await env.DB.prepare(
      `INSERT INTO photos
         (id, content_hash, source, filename, subjects, tags, description,
          environment, album, model_provider, model_name, search_text, last_indexed)
       VALUES (?, ?, 'local', 'leopard.jpg', '["leopard"]', '["leopard","big cat"]',
               'A leopard resting in a tree', 'forest', 'Kanha', 'ollama',
               'qwen3.5:27b-mlx', 'leopard big cat leopard resting tree forest kanha',
               '2026-09-18T00:00:00.000Z')`
    )
      .bind('photo-1', 'hash-1')
      .run();

    const row = await env.DB.prepare('SELECT * FROM photos WHERE id = ?')
      .bind('photo-1')
      .first();
    expect(row?.filename).toBe('leopard.jpg');

    const match = await env.DB.prepare(
      `SELECT photos.id FROM photos
       JOIN photos_fts ON photos.rowid = photos_fts.rowid
       WHERE photos_fts MATCH 'leopard'`
    ).all();
    expect(match.results.map((r) => r.id)).toEqual(['photo-1']);
  });
});
