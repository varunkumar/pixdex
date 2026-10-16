import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { combinedScore } from '../src/db/rating';

const read = { Authorization: `Bearer ${env.READ_TOKEN}` };
const ID = '123e4567-e89b-12d3-a456-426614174000';

const payload = {
  id: ID,
  contentHash: 'hash-eagle',
  source: 'local' as const,
  filename: 'eagle.jpg',
  subjects: ['serpent eagle'],
  tags: ['raptor'],
  description: 'A raptor on a branch.',
  album: 'Bandipur',
  modelProvider: 'ollama',
  modelName: 'qwen3.5:27b-mlx',
  aestheticScore: 6,
  shortCaption: 'Serpent eagle',
};

const ingest = () =>
  SELF.fetch('https://example.com/ingest/photo', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.INGEST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

const patch = (body: unknown, id = ID) =>
  SELF.fetch(`https://example.com/photos/${id}`, {
    method: 'PATCH',
    headers: { ...read, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const searchIds = async (q: string, extra = '') => {
  const res = await SELF.fetch(`https://example.com/search?q=${encodeURIComponent(q)}${extra}`, { headers: read });
  return ((await res.json()) as any).results.map((r: any) => r.id) as string[];
};

describe('combinedScore', () => {
  it('uses the model score alone without a human rating', () => {
    expect(combinedScore({ aesthetic_score: 6 })).toBe(6);
    expect(combinedScore({})).toBeNull();
  });
  it('lets the human rating dominate', () => {
    expect(combinedScore({ user_rating: 5, aesthetic_score: 4 })).toBeCloseTo(8.2);
    expect(combinedScore({ user_rating: 1, aesthetic_score: 9 })).toBeCloseTo(4.1);
    expect(combinedScore({ user_rating: 4 })).toBe(8);
  });
});

describe('PATCH /photos/:id', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM photos').run();
    await ingest();
  });

  it('stores the rating and returns effective values with the overrides', async () => {
    const res = await patch({ userRating: 5, caption: 'Crested hawk-eagle', subjects: ['crested hawk-eagle'] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.userRating).toBe(5);
    expect(body.shortCaption).toBe('Crested hawk-eagle');
    expect(body.subjects).toEqual(['crested hawk-eagle']);
    expect(body.tags).toEqual(['raptor']);
    expect(body.overrides).toEqual({ shortCaption: 'Crested hawk-eagle', subjects: ['crested hawk-eagle'], tags: null });
    expect(body.combinedScore).toBeCloseTo(0.7 * 10 + 0.3 * 6);
  });

  it('re-indexes search so the corrected species matches and the wrong one does not', async () => {
    expect(await searchIds('serpent')).toEqual([ID]);
    await patch({ caption: 'Crested hawk-eagle', subjects: ['crested hawk-eagle'] });
    expect(await searchIds('serpent')).toEqual([]);
    expect(await searchIds('crested')).toEqual([ID]);
  });

  it('keeps search_primary on the effective subjects, tags and caption', async () => {
    await ingest();
    let row = await env.DB.prepare('SELECT search_primary FROM photos WHERE id = ?').bind(ID).first<{ search_primary: string }>();
    expect(row?.search_primary).toBe('serpent eagle raptor Serpent eagle');
    await patch({ subjects: ['crested hawk-eagle'] });
    row = await env.DB.prepare('SELECT search_primary FROM photos WHERE id = ?').bind(ID).first<{ search_primary: string }>();
    expect(row?.search_primary).toBe('crested hawk-eagle raptor Serpent eagle');
  });

  it('leaves omitted fields alone and clears an override with null', async () => {
    await patch({ userRating: 4, tags: ['hawk-eagle'] });
    await patch({ userRating: null });
    const body = (await (await patch({ caption: 'x' })).json()) as any;
    expect(body.userRating).toBeNull();
    expect(body.tags).toEqual(['hawk-eagle']);
    const cleared = (await (await patch({ tags: [] })).json()) as any;
    expect(cleared.tags).toEqual(['raptor']);
    expect(cleared.overrides.tags).toBeNull();
  });

  it('rejects bad input and unknown photos', async () => {
    expect((await patch({ userRating: 6 })).status).toBe(400);
    expect((await patch({ userRating: 2.5 })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect((await patch({ userRating: 3 }, 'nope')).status).toBe(404);
  });

  it('requires the read token', async () => {
    const res = await SELF.fetch(`https://example.com/photos/${ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userRating: 3 }),
    });
    expect(res.status).toBe(401);
  });

  it('keeps search_primary on the owner edits after the agent re-indexes', async () => {
    await patch({ caption: 'Crested hawk-eagle', subjects: ['crested hawk-eagle'], tags: ['hunting'] });
    await ingest();
    const row = await env.DB.prepare('SELECT search_primary FROM photos WHERE id = ?').bind(ID).first<{ search_primary: string }>();
    expect(row?.search_primary).toBe('crested hawk-eagle hunting Crested hawk-eagle');
  });

  it('survives the agent re-indexing the photo', async () => {
    await patch({ userRating: 5, caption: 'Crested hawk-eagle', subjects: ['crested hawk-eagle'] });
    await ingest();
    const photo = (await (await SELF.fetch(`https://example.com/photos/${ID}`, { headers: read })).json()) as any;
    expect(photo.userRating).toBe(5);
    expect(photo.subjects).toEqual(['crested hawk-eagle']);
    expect(await searchIds('serpent')).toEqual([]);
    expect(await searchIds('crested')).toEqual([ID]);
  });
});

describe('ranking uses the human rating', () => {
  async function seed(id: string, aesthetic: number, album = 'A') {
    await env.DB.prepare(
      `INSERT INTO photos (id, content_hash, source, filename, album, aesthetic_score, subjects, description, model_provider, model_name, search_text, last_indexed)
       VALUES (?,?,'local',?,?,?,'["bird"]','A bird.','ollama','m','bird','2026-09-18T00:00:00.000Z')`
    )
      .bind(id, `h-${id}`, `${id}.jpg`, album, aesthetic)
      .run();
  }
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM photos').run();
  });

  it('sort=rating puts a 5-star photo above a higher model score (8.8 vs 8)', async () => {
    await seed('model-9', 8);
    await seed('human-5', 6);
    await patch({ userRating: 5 }, 'human-5');
    expect(await searchIds('bird', '&sort=rating')).toEqual(['human-5', 'model-9']);
  });

  it('album average blends the human rating', async () => {
    await seed('a1', 5, 'Low');
    await seed('b1', 5, 'High');
    await patch({ userRating: 5 }, 'b1');
    const res = await SELF.fetch('https://example.com/albums?limit=12&sort=rating', { headers: read });
    expect(((await res.json()) as any).albums.map((a: any) => a.name)).toEqual(['High', 'Low']);
  });

  it('daily pick prefers the photo the owner rated highly', async () => {
    await seed('model-9', 9);
    await seed('human-5', 8);
    await patch({ userRating: 5 }, 'human-5');
    const res = await SELF.fetch('https://example.com/daily-pick', { headers: read });
    expect(((await res.json()) as any).photo.id).toBe('human-5');
  });

  it('daily pick drops a photo the owner rated poorly', async () => {
    await seed('model-9', 9);
    await seed('meh', 9.5);
    await patch({ userRating: 1 }, 'meh');
    const res = await SELF.fetch('https://example.com/daily-pick', { headers: read });
    expect(((await res.json()) as any).photo.id).toBe('model-9');
  });
});
