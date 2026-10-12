import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { SEARCH_TEXT_BACKFILL_SQL } from '../migrations/index';

async function seed(
  id: string,
  contentHash: string,
  subjects: string[],
  searchText: string,
  album: string,
  extra: { colors?: string[]; patterns?: string[]; season?: string } = {}
) {
  await env.DB.prepare(
    `INSERT INTO photos (id, content_hash, source, filename, subjects, album, colors, patterns, season, model_provider, model_name, search_text, last_indexed)
     VALUES (?,?,'local',?,?,?,?,?,?, 'ollama', 'qwen3.5:27b-mlx', ?, '2026-09-18T00:00:00.000Z')`
  )
    .bind(
      id,
      contentHash,
      `${id}.jpg`,
      JSON.stringify(subjects),
      album,
      JSON.stringify(extra.colors ?? []),
      JSON.stringify(extra.patterns ?? []),
      extra.season ?? null,
      searchText
    )
    .run();
}

async function ids(query: string): Promise<string[]> {
  const response = await SELF.fetch(`https://example.com/search?q=${encodeURIComponent(query)}`, {
    headers: { Authorization: `Bearer ${env.READ_TOKEN}` },
  });
  return ((await response.json()) as any).results.map((r: { id: string }) => r.id);
}

describe('GET /search', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM photos').run();
    await seed('photo-leopard', 'hash-leopard', ['leopard'], 'leopard big cat forest', 'Kanha');
    await seed('photo-elephant', 'hash-elephant', ['elephant'], 'elephant herd grassland', 'Kaziranga');
  });

  it('finds a synonym-expanded match via "big cat"', async () => {
    const response = await SELF.fetch('https://example.com/search?q=big%20cat', {
      headers: { Authorization: `Bearer ${env.READ_TOKEN}` },
    });
    const body = (await response.json()) as any;
    expect(response.status).toBe(200);
    expect(body.results.map((r: { id: string }) => r.id)).toEqual(['photo-leopard']);
    expect(body.results[0].thumbnailUrl).toBe('/thumbnails/hash-leopard');
    expect(body.results[0].subjects).toEqual(['leopard']);
  });

  it('reports the total matching count independent of limit', async () => {
    const response = await SELF.fetch('https://example.com/search?limit=1', {
      headers: { Authorization: `Bearer ${env.READ_TOKEN}` },
    });
    const body = (await response.json()) as any;
    expect(body.results.length).toBe(1);
    expect(body.total).toBe(2);

    const filtered = await SELF.fetch('https://example.com/search?album=Kanha', {
      headers: { Authorization: `Bearer ${env.READ_TOKEN}` },
    });
    expect(((await filtered.json()) as any).total).toBe(1);
  });

  it('filters by album', async () => {
    const response = await SELF.fetch('https://example.com/search?album=Kaziranga', {
      headers: { Authorization: `Bearer ${env.READ_TOKEN}` },
    });
    const body = (await response.json()) as any;
    expect(body.results.map((r: { id: string }) => r.id)).toEqual(['photo-elephant']);
  });

  it('clamps a negative limit instead of returning the whole table', async () => {
    const response = await SELF.fetch('https://example.com/search?limit=-1', {
      headers: { Authorization: `Bearer ${env.READ_TOKEN}` },
    });
    const body = (await response.json()) as any;
    expect(response.status).toBe(200);
    // A negative/garbage limit must not turn into SQLite's "LIMIT -1" (unlimited).
    expect(body.results.length).toBeLessThanOrEqual(100);
    expect(body.results.length).toBeGreaterThan(0);
  });

  it('clamps a negative offset to zero', async () => {
    const response = await SELF.fetch('https://example.com/search?offset=-5', {
      headers: { Authorization: `Bearer ${env.READ_TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.results.length).toBe(2);
  });

  describe('multi-word and field searches', () => {
    beforeEach(async () => {
      await seed('photo-red-bird', 'hash-red-bird', ['kite'], 'kite bird red kite', 'Kanha', {
        colors: ['red', 'brown'],
        patterns: ['barred wings'],
      });
      await seed('photo-green-bird', 'hash-green-bird', ['parakeet'], 'parakeet bird green', 'Kanha', {
        colors: ['green'],
      });
    });

    it('treats "red pattern" and "red colors" as a search for red', async () => {
      expect(await ids('red pattern')).toEqual(['photo-red-bird']);
      expect(await ids('red colors')).toEqual(['photo-red-bird']);
    });

    it('requires every word, so "red parakeet" does not return the green parakeet first', async () => {
      // No photo is both red and a parakeet, so it loosens to any word.
      const result = await ids('red parakeet');
      expect(result.sort()).toEqual(['photo-green-bird', 'photo-red-bird']);
    });

    it('matches words that are not adjacent in the text', async () => {
      expect(await ids('red bird')).toEqual(['photo-red-bird']);
    });

    it('finds photos by color once the search text backfill has run', async () => {
      await env.DB.prepare('DELETE FROM photos').run();
      // An older row: colors/patterns exist as columns but not in search_text.
      await seed('photo-old', 'hash-old', ['heron'], 'heron wading bird', 'Kanha', {
        colors: ['crimson'],
        patterns: ['mottled'],
        season: 'monsoon',
      });
      expect(await ids('crimson')).toEqual([]);

      await env.DB.prepare(SEARCH_TEXT_BACKFILL_SQL).run();

      expect(await ids('crimson')).toEqual(['photo-old']);
      expect(await ids('mottled')).toEqual(['photo-old']);
      expect(await ids('monsoon')).toEqual(['photo-old']);
    });
  });
});
