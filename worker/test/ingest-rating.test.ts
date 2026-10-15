import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

const post = (body: unknown) =>
  SELF.fetch('https://example.com/ingest/rating', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.INGEST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /ingest/rating', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM photos').run();
    await env.DB.prepare(
      `INSERT INTO photos (id, content_hash, source, filename, model_provider, model_name, last_indexed)
       VALUES ('p1','h1','local','p1.jpg','ollama','m','2026-09-18T00:00:00.000Z')`
    ).run();
  });

  it('sets the score by content hash', async () => {
    expect((await post({ contentHash: 'h1', score: 8.5 })).status).toBe(200);
    const row = await env.DB.prepare('SELECT aesthetic_score FROM photos WHERE id = ?').bind('p1').first<{ aesthetic_score: number }>();
    expect(row?.aesthetic_score).toBe(8.5);
  });

  it('sets the short caption, and a field left out keeps its value', async () => {
    await post({ contentHash: 'h1', score: 6 });
    expect((await post({ contentHash: 'h1', shortCaption: 'Leopard at dusk' })).status).toBe(200);
    const row = await env.DB.prepare('SELECT aesthetic_score, short_caption FROM photos WHERE id = ?')
      .bind('p1')
      .first<{ aesthetic_score: number; short_caption: string }>();
    expect(row).toEqual({ aesthetic_score: 6, short_caption: 'Leopard at dusk' });
  });

  it('makes the caption searchable once, even when sent again', async () => {
    await post({ contentHash: 'h1', shortCaption: 'Sleepy marmot' });
    await post({ contentHash: 'h1', shortCaption: 'Sleepy marmot' });

    const row = await env.DB.prepare('SELECT search_text FROM photos WHERE id = ?').bind('p1').first<{ search_text: string }>();
    expect(row?.search_text.split('Sleepy marmot').length).toBe(2);

    const res = await SELF.fetch('https://example.com/search?q=marmot', {
      headers: { Authorization: `Bearer ${env.READ_TOKEN}` },
    });
    expect(JSON.stringify(await res.json())).toContain('p1');
  });

  it('requires the ingest token (the read token is not enough)', async () => {
    for (const headers of [{} as Record<string, string>, { Authorization: `Bearer ${env.READ_TOKEN}` }]) {
      const res = await SELF.fetch('https://example.com/ingest/rating', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ contentHash: 'h1', score: 5 }),
      });
      expect(res.status).toBe(401);
    }
  });

  it('400s when neither score nor shortCaption is given', async () => {
    expect((await post({ contentHash: 'h1' })).status).toBe(400);
  });

  it('404s for an unknown hash and 400s for an out-of-range score', async () => {
    expect((await post({ contentHash: 'nope', score: 5 })).status).toBe(404);
    expect((await post({ contentHash: 'h1', score: 11 })).status).toBe(400);
  });
});
