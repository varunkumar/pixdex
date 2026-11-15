import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { readHeaders } from './helpers';

const read = readHeaders();
const ingestHeaders = () => ({ Authorization: `Bearer ${env.INGEST_TOKEN}`, 'Content-Type': 'application/json' });

const oriole = { common: 'Indian Golden Oriole', scientific: 'Oriolus kundoo', score: 0.98 };
const myna = { common: 'Jungle myna', scientific: 'Acridotheres fuscus', score: 0.999, box: [0.1, 0.2, 0.3, 0.4] };

const post = (photos: unknown, model: unknown = 'bioclip-2') =>
  SELF.fetch('https://example.com/ingest/species', {
    method: 'POST',
    headers: ingestHeaders(),
    body: JSON.stringify({ model, photos }),
  });

const search = async (q: string) => {
  const res = await SELF.fetch(`https://example.com/search?q=${encodeURIComponent(q)}`, { headers: read });
  const body = (await res.json()) as { results: { id: string; species: unknown[] }[] };
  return body.results;
};
const searchIds = async (q: string) => (await search(q)).map((r) => r.id);

describe('POST /ingest/species', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM photos').run();
    await env.DB.prepare(
      `INSERT INTO photos (id, content_hash, source, filename, album, subjects, description, search_text, search_primary, model_provider, model_name, last_indexed)
       VALUES ('p1','h1','local','p1.jpg','A','["bird"]','A bird on a long branch in the early morning light','bird on a long branch in the early morning light','bird','ollama','m','2026-09-18T00:00:00.000Z'),
              ('p2','h2','local','p2.jpg','A','["tree"]','An oriole far away in a tree','An oriole far away in a tree','tree','ollama','m','2026-09-19T00:00:00.000Z')`
    ).run();
  });

  it('stores the species and the model by content hash', async () => {
    const res = await post([{ contentHash: 'h1', species: [oriole, myna] }]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 1, unknown: 0 });
    const row = await env.DB.prepare('SELECT species, species_model FROM photos WHERE id = ?').bind('p1').first<{ species: string; species_model: string }>();
    expect(JSON.parse(row!.species)).toEqual([oriole, myna]);
    expect(row!.species_model).toBe('bioclip-2');
  });

  it('makes both the common and the scientific name searchable', async () => {
    await post([{ contentHash: 'h1', species: [oriole] }]);
    expect(await searchIds('Indian Golden Oriole')).toContain('p1');
    expect(await searchIds('Oriolus kundoo')).toContain('p1');
  });

  it('ranks a species match above a photo that only mentions the word in its text', async () => {
    await post([{ contentHash: 'h1', species: [oriole] }]);
    // p2 is newer and only has "oriole" in search_text, so without species priority it would sort first.
    expect((await searchIds('oriole'))[0]).toBe('p1');
  });

  it('indexes both species of a two-animal photo', async () => {
    await post([{ contentHash: 'h1', species: [oriole, myna] }]);
    expect(await searchIds('myna')).toContain('p1');
    expect(await searchIds('Acridotheres')).toContain('p1');
  });

  it('replaces earlier species instead of piling them up, and is safe to repeat', async () => {
    await post([{ contentHash: 'h1', species: [oriole] }]);
    await post([{ contentHash: 'h1', species: [myna] }]);
    await post([{ contentHash: 'h1', species: [myna] }]);
    expect(await searchIds('Oriolus')).not.toContain('p1');
    const row = await env.DB.prepare('SELECT search_text, search_primary FROM photos WHERE id = ?').bind('p1').first<{ search_text: string; search_primary: string }>();
    expect(row!.search_text.split('Jungle myna').length).toBe(2);
    expect(row!.search_primary.split('Jungle myna').length).toBe(2);
  });

  it('keeps the existing text in the index', async () => {
    await post([{ contentHash: 'h1', species: [oriole] }]);
    expect(await searchIds('branch')).toContain('p1');
  });

  it('counts unknown hashes and still updates the known ones', async () => {
    const res = await post([{ contentHash: 'nope', species: [oriole] }, { contentHash: 'h1', species: [oriole] }]);
    expect(await res.json()).toEqual({ updated: 1, unknown: 1 });
  });

  it('clears the species when an empty list is sent', async () => {
    await post([{ contentHash: 'h1', species: [oriole] }]);
    await post([{ contentHash: 'h1', species: [] }]);
    expect(await searchIds('Oriolus')).not.toContain('p1');
    const row = await env.DB.prepare('SELECT species, species_model FROM photos WHERE id = ?').bind('p1').first<{ species: string; species_model: string }>();
    expect(row).toEqual({ species: '[]', species_model: 'bioclip-2' });
  });

  it('stores species but does not index them when the owner has set subjects', async () => {
    await env.DB.prepare(`UPDATE photos SET user_subjects = '["kingfisher"]' WHERE id = 'p1'`).run();
    await post([{ contentHash: 'h1', species: [oriole] }]);
    expect(await searchIds('Oriolus')).not.toContain('p1');
    const row = await env.DB.prepare('SELECT species FROM photos WHERE id = ?').bind('p1').first<{ species: string }>();
    expect(JSON.parse(row!.species)).toEqual([oriole]);
  });

  it('returns the species with the photo', async () => {
    await post([{ contentHash: 'h1', species: [oriole] }]);
    const hit = (await search('Oriolus')).find((r) => r.id === 'p1');
    expect(hit?.species).toEqual([oriole]);
  });

  it('updates a batch of 100 in one request', async () => {
    const photos = Array.from({ length: 100 }, (_, i) => ({ contentHash: i === 0 ? 'h1' : `x${i}`, species: [oriole] }));
    const res = await post(photos);
    expect(await res.json()).toEqual({ updated: 1, unknown: 99 });
  });

  describe('validation', () => {
    it('rejects an empty batch, more than 100 photos, a missing model and a bad score', async () => {
      expect((await post([])).status).toBe(400);
      expect((await post(Array.from({ length: 101 }, () => ({ contentHash: 'h1', species: [] })))).status).toBe(400);
      expect((await post([{ contentHash: 'h1', species: [oriole] }], '')).status).toBe(400);
      expect((await post([{ contentHash: 'h1', species: [{ ...oriole, score: 1.5 }] }])).status).toBe(400);
      expect((await post([{ contentHash: 'h1', species: Array.from({ length: 13 }, () => oriole) }])).status).toBe(400);
      expect((await post([{ contentHash: 'h1', species: [{ ...oriole, box: [0, 0, 1] }] }])).status).toBe(400);
    });

    it('needs the ingest token', async () => {
      const res = await SELF.fetch('https://example.com/ingest/species', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.READ_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'bioclip-2', photos: [{ contentHash: 'h1', species: [] }] }),
      });
      expect(res.status).toBe(401);
    });
  });
});

describe('species and POST /ingest/photo', () => {
  const ID = '123e4567-e89b-12d3-a456-426614174000';
  const payload = {
    id: ID,
    contentHash: 'hash-sp',
    source: 'local' as const,
    filename: 'bird.jpg',
    subjects: ['bird'],
    tags: ['songbird'],
    description: 'A bird on a branch.',
    album: 'A',
    modelProvider: 'ollama',
    modelName: 'm',
    ownerEmail: 'owner@example.com',
  };
  const ingest = (extra: Record<string, unknown> = {}) =>
    SELF.fetch('https://example.com/ingest/photo', { method: 'POST', headers: ingestHeaders(), body: JSON.stringify({ ...payload, ...extra }) });

  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM photos').run();
  });

  it('stores and indexes species sent with the photo', async () => {
    expect((await ingest({ species: [oriole], speciesModel: 'bioclip-2' })).status).toBe(201);
    expect(await searchIds('Oriolus')).toContain(ID);
    const row = await env.DB.prepare('SELECT species_model FROM photos WHERE id = ?').bind(ID).first<{ species_model: string }>();
    expect(row?.species_model).toBe('bioclip-2');
  });

  it('keeps earlier species when the photo is re-indexed without any', async () => {
    await ingest({ species: [oriole], speciesModel: 'bioclip-2' });
    await ingest();
    expect(await searchIds('Oriolus')).toContain(ID);
    const row = await env.DB.prepare('SELECT species, species_model FROM photos WHERE id = ?').bind(ID).first<{ species: string; species_model: string }>();
    expect(JSON.parse(row!.species)).toEqual([oriole]);
    expect(row!.species_model).toBe('bioclip-2');
  });

  it('a photo without species has an empty list', async () => {
    await ingest();
    const row = await env.DB.prepare('SELECT species, species_model FROM photos WHERE id = ?').bind(ID).first<{ species: string; species_model: string | null }>();
    expect(row).toEqual({ species: '[]', species_model: null });
  });
});

describe('species and the owner review (PATCH /photos/:id)', () => {
  const ID = '223e4567-e89b-12d3-a456-426614174000';
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM photos').run();
    await SELF.fetch('https://example.com/ingest/photo', {
      method: 'POST',
      headers: ingestHeaders(),
      body: JSON.stringify({ id: ID, contentHash: 'hash-pr', source: 'local', filename: 'b.jpg', subjects: ['bird'], album: 'A', modelProvider: 'ollama', modelName: 'm', ownerEmail: 'owner@example.com', species: [oriole], speciesModel: 'bioclip-2' }),
    });
  });
  const patch = (body: unknown) =>
    SELF.fetch(`https://example.com/photos/${ID}`, { method: 'PATCH', headers: { ...read, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('stops indexing the species once the owner corrects the subjects, and resumes when cleared', async () => {
    expect(await searchIds('Oriolus')).toContain(ID);
    await patch({ subjects: ['kingfisher'] });
    expect(await searchIds('Oriolus')).not.toContain(ID);
    await patch({ subjects: [] });
    expect(await searchIds('Oriolus')).toContain(ID);
  });
});
