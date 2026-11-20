import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { speciesFilterSql } from '../src/db/species';
import { OWNER_TEST_EMAIL, readHeaders } from './helpers';

const run = (sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params).run();
const get = (path: string, as: string = OWNER_TEST_EMAIL) => SELF.fetch(`https://example.com${path}`, { headers: readHeaders(as) });
const json = async (path: string, as?: string) => (await get(path, as)).json<any>();
const ids = async (path: string, as?: string) => (await json(path, as)).results.map((p: { id: string }) => p.id).sort();

const elephant = JSON.stringify([{ common: 'Asian elephant', scientific: 'Elephas maximus', score: 0.9 }]);
const both = JSON.stringify([
  { common: 'Asian elephant', scientific: 'Elephas maximus', score: 0.8 },
  { common: 'Tiger', scientific: 'Panthera tigris', score: 0.7 },
]);

async function insert(id: string, album: string, species: string | null) {
  await run(
    `INSERT INTO photos (id, content_hash, source, filename, album, date_time, model_provider, model_name, last_indexed, species)
     VALUES (?, ?, 'local', 'a.jpg', ?, '2026-03-05T10:00:00', 'ollama', 'm', '2026-01-01T00:00:00.000Z', ?)`,
    id,
    `hash-${id}-0123456789`,
    album,
    // The column is NOT NULL DEFAULT '[]', so a null here stands for "never scanned" and takes the default.
    species ?? '[]'
  );
}

describe('speciesFilterSql', () => {
  it('is empty for undefined, blank or over-long names and binds the name', () => {
    expect(speciesFilterSql(undefined)).toEqual({ sql: '', params: [] });
    expect(speciesFilterSql('   ')).toEqual({ sql: '', params: [] });
    expect(speciesFilterSql('x'.repeat(201))).toEqual({ sql: '', params: [] });
    const f = speciesFilterSql(' Elephas maximus ');
    expect(f.params).toEqual(['Elephas maximus']);
    expect(f.sql).not.toContain('Elephas');
  });
});

describe('GET /search?species=', () => {
  beforeEach(async () => {
    await run('DELETE FROM faces');
    await run('DELETE FROM photos');
    await insert('e1', 'A', elephant);
    await insert('e2', 'A', both);
    await insert('t1', 'A', JSON.stringify([{ common: 'Tiger', scientific: 'Panthera tigris', score: 0.9 }]));
    await insert('nul', 'A', null);
    await insert('empty', 'A', '[]');
    await insert('bad', 'A', '{not json');
    await insert('other', 'B', elephant);
  });

  it('returns only photos of the album with that scientific name', async () => {
    expect(await ids('/search?album=A&species=Elephas%20maximus')).toEqual(['e1', 'e2']);
  });

  it('never returns NULL, empty or invalid-JSON species and does not 500', async () => {
    expect((await get('/search?album=A&species=Elephas%20maximus')).status).toBe(200);
    expect((await get('/search?species=Panthera%20tigris')).status).toBe(200);
    expect(await ids('/search?species=Panthera%20tigris')).toEqual(['e2', 't1']);
  });

  it('ignores species JSON that is not an array of objects without a 500', async () => {
    await insert('str', 'A', '["Elephas maximus"]');
    await insert('num', 'A', '[1, null, "x"]');
    await insert('obj', 'A', '{"scientific":"Elephas maximus"}');
    expect((await get('/search?species=Elephas%20maximus')).status).toBe(200);
    expect(await ids('/search?album=A&species=Elephas%20maximus')).toEqual(['e1', 'e2']);
  });

  it('an unknown name gives zero results', async () => {
    const body = await json('/search?album=A&species=Nope%20nope');
    expect(body.total).toBe(0);
    expect(body.results).toEqual([]);
  });

  it('ANDs with the people filter', async () => {
    await run(`INSERT INTO persons (id, name, created_at, owner_email) VALUES ('pp', 'Pat', '2026-01-01T00:00:00.000Z', ?)`, OWNER_TEST_EMAIL);
    await run(
      `INSERT INTO faces (id, photo_id, person_id, assign_status, bbox_x, bbox_y, bbox_w, bbox_h, det_score, embedding, embedding_model, crop_key, created_at)
       VALUES ('f1', 'e2', 'pp', 'confirmed', 0, 0, 1, 1, 0.9, x'00', 'm', 'c', '2026-01-01T00:00:00.000Z')`
    );
    expect(await ids('/search?album=A&species=Elephas%20maximus&people=pp')).toEqual(['e2']);
  });

  it('a stranger sees nothing of a private album', async () => {
    const body = await json('/search?album=A&species=Elephas%20maximus', 'stranger@example.com');
    expect(body.total).toBe(0);
  });
});
