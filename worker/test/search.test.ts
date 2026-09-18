import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

async function seed(id: string, contentHash: string, subjects: string[], searchText: string, album: string) {
  await env.DB.prepare(
    `INSERT INTO photos (id, content_hash, source, filename, subjects, album, model_provider, model_name, search_text, last_indexed)
     VALUES (?,?,'local',?,?,?, 'ollama', 'qwen3.5:27b-mlx', ?, '2026-09-18T00:00:00.000Z')`
  )
    .bind(id, contentHash, `${id}.jpg`, JSON.stringify(subjects), album, searchText)
    .run();
}

describe('GET /search', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM photos').run();
    await seed('photo-leopard', 'hash-leopard', ['leopard'], 'leopard big cat forest', 'Kanha');
    await seed('photo-elephant', 'hash-elephant', ['elephant'], 'elephant herd grassland', 'Kaziranga');
  });

  it('finds a synonym-expanded match via "big cat"', async () => {
    const response = await SELF.fetch('https://example.com/search?q=big%20cat');
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.results.map((r: { id: string }) => r.id)).toEqual(['photo-leopard']);
    expect(body.results[0].thumbnailUrl).toBe('/thumbnails/hash-leopard');
    expect(body.results[0].subjects).toEqual(['leopard']);
  });

  it('filters by album', async () => {
    const response = await SELF.fetch('https://example.com/search?album=Kaziranga');
    const body = await response.json();
    expect(body.results.map((r: { id: string }) => r.id)).toEqual(['photo-elephant']);
  });
});
