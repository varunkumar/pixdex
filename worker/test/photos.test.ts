import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

describe('GET /photos/:id and GET /albums', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM photos').run();
    await env.DB.prepare(
      `INSERT INTO photos (id, content_hash, source, filename, subjects, colors, patterns, tags, suggested_hashtags, album, model_provider, model_name, search_text, last_indexed)
       VALUES ('photo-1','hash-1','local','a.jpg','[]','[]','[]','[]','[]','Kanha','ollama','qwen3.5:27b-mlx','','2026-09-18T00:00:00.000Z')`
    ).run();
  });

  it('GET /photos/:id returns the photo', async () => {
    const response = await SELF.fetch('https://example.com/photos/photo-1', {
      headers: { Authorization: `Bearer ${env.READ_TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as any).filename).toBe('a.jpg');
  });

  it('GET /photos/:id returns 404 for an unknown id', async () => {
    const response = await SELF.fetch('https://example.com/photos/does-not-exist', {
      headers: { Authorization: `Bearer ${env.READ_TOKEN}` },
    });
    expect(response.status).toBe(404);
  });

  it('GET /albums returns distinct album names', async () => {
    const response = await SELF.fetch('https://example.com/albums', {
      headers: { Authorization: `Bearer ${env.READ_TOKEN}` },
    });
    expect(await response.json()).toEqual({ albums: ['Kanha'] });
  });
});
