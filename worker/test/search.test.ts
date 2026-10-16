import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { SEARCH_PRIMARY_BACKFILL_SQL, SEARCH_TEXT_BACKFILL_SQL } from '../migrations/index';

async function seed(
  id: string,
  contentHash: string,
  subjects: string[],
  searchText: string,
  album: string,
  extra: { colors?: string[]; patterns?: string[]; season?: string; primary?: string } = {}
) {
  await env.DB.prepare(
    `INSERT INTO photos (id, content_hash, source, filename, subjects, album, colors, patterns, season, model_provider, model_name, search_text, search_primary, last_indexed)
     VALUES (?,?,'local',?,?,?,?,?,?, 'ollama', 'qwen3.5:27b-mlx', ?, ?, '2026-09-18T00:00:00.000Z')`
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
      searchText,
      extra.primary ?? ''
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
  describe('category and action queries', () => {
    beforeEach(async () => {
      await env.DB.prepare('DELETE FROM photos').run();
      await seed('leopard-tree', 'h1', ['leopard'], 'leopard sleeping on a tree in forest', 'Kanha');
      await seed('tiger-branch', 'h2', ['tiger'], 'tiger resting on a branch', 'Kanha');
      await seed('tiger-grass', 'h3', ['tiger'], 'tiger walking in grass', 'Kanha');
      await seed('crow-tree', 'h4', ['crow'], 'crow sitting on a tree', 'Kanha');
    });

    it('finds big cats sleeping on a tree across species and wording', async () => {
      expect((await ids('big cats sleeping on a tree')).sort()).toEqual(['leopard-tree', 'tiger-branch']);
    });

    it('drops the action when nothing matches it, keeping the nouns', async () => {
      expect((await ids('big cat flying on a tree')).sort()).toEqual(['leopard-tree', 'tiger-branch']);
    });
  });

  describe('field weighting', () => {
    beforeEach(async () => {
      await env.DB.prepare('DELETE FROM photos').run();
    });

    it('ranks a photo whose subjects match above one that only mentions the word in its description', async () => {
      await seed('mention', 'hm', ['elephant'], 'tiger tiger tiger far away behind an elephant', 'Kanha', { primary: 'elephant' });
      await seed('subject', 'hs', ['tiger'], 'tiger resting in the forest at dusk', 'Kanha', { primary: 'tiger' });
      expect(await ids('tiger')).toEqual(['subject', 'mention']);
    });

    it('fills search_primary from subjects, tags, colors and caption, honouring owner overrides', async () => {
      await env.DB.prepare(
        `INSERT INTO photos (id, content_hash, source, filename, subjects, tags, colors, short_caption, user_subjects, model_provider, model_name, search_text, last_indexed)
         VALUES ('p1','hp1','local','p1.jpg','["crow"]','["perched"]','["black"]','Dusk call','["raven"]','ollama','m','x','2026-09-18T00:00:00.000Z')`
      ).run();
      await env.DB.prepare(SEARCH_PRIMARY_BACKFILL_SQL).run();
      const row = await env.DB.prepare('SELECT search_primary FROM photos WHERE id = ?').bind('p1').first<{ search_primary: string }>();
      const words = row!.search_primary.split(/\s+/);
      expect(words).toEqual(expect.arrayContaining(['raven', 'perched', 'black', 'Dusk', 'call']));
      expect(words).not.toContain('crow');
    });
  });

  describe('colour queries', () => {
    beforeEach(async () => {
      await env.DB.prepare('DELETE FROM photos').run();
      await seed('tiger-green', 'c1', ['tiger'], 'tiger green forest', 'Kanha', { colors: ['olive green', 'orange'] });
      await seed('tiger-red', 'c2', ['tiger'], 'tiger red dusk', 'Kanha', { colors: ['crimson', 'black'] });
      await seed('zebra', 'c3', ['zebra'], 'zebra black white', 'Kanha', { colors: ['black', 'white'] });
    });

    it('ignores "prominent" and "shade" and matches colour synonyms', async () => {
      expect(await ids('prominent red shade')).toEqual(['tiger-red']);
    });

    it('treats "background" as filler: tiger on a green background', async () => {
      expect(await ids('tiger on a green background')).toEqual(['tiger-green']);
    });

    it('finds black and white', async () => {
      expect(await ids('black and white')).toContain('zebra');
    });
  });

  it('sort=date orders by photo date newest first, nulls last', async () => {
    await env.DB.prepare('DELETE FROM photos').run();
    const insert = (id: string, date: string | null) =>
      env.DB.prepare(
        `INSERT INTO photos (id, content_hash, source, filename, album, date_time, model_provider, model_name, search_text, last_indexed)
         VALUES (?,?,'local',?,'Kanha',?,'ollama','qwen3.5:27b-mlx','','2026-09-18T00:00:00.000Z')`
      )
        .bind(id, `h-${id}`, `${id}.jpg`, date)
        .run();
    await insert('old', '2026-01-01T00:00:00.000Z');
    await insert('undated', null);
    await insert('new', '2026-05-01T00:00:00.000Z');

    const response = await SELF.fetch('https://example.com/search?album=Kanha&sort=date', {
      headers: { Authorization: `Bearer ${env.READ_TOKEN}` },
    });
    const body = (await response.json()) as any;
    expect(body.results.map((r: { id: string }) => r.id)).toEqual(['new', 'old', 'undated']);
  });

});
