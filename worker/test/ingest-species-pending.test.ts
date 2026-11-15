import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

const headers = () => ({ Authorization: `Bearer ${env.INGEST_TOKEN}`, 'Content-Type': 'application/json' });
const call = (path: string, body: unknown) =>
  SELF.fetch(`https://example.com/ingest/species/${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
const pending = (body: Record<string, unknown> = {}) => call('pending', { model: 'bioclip-2', limit: 100, ...body });

type Item = { contentHash: string; source: string; path: string | null; driveFileId: string | null; album: string | null; filename: string; latitude: number | null; longitude: number | null; subjects: string[] };
type Page = { items: Item[]; nextCursor: number | null };

const insert = (id: string, extra: { source?: string; path?: string | null; drive?: string | null; album?: string | null; model?: string | null; lat?: number; lon?: number; subjects?: string } = {}) =>
  env.DB.prepare(
    `INSERT INTO photos (id, content_hash, source, path, drive_file_id, filename, album, subjects, latitude, longitude, species_model, model_provider, model_name, last_indexed)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,'ollama','m','2026-09-18T00:00:00.000Z')`
  )
    .bind(id, `h-${id}`, extra.source ?? 'local', extra.path === undefined ? `/p/${id}.jpg` : extra.path, extra.drive ?? null, `${id}.jpg`, extra.album === undefined ? 'A' : extra.album, extra.subjects ?? '["bird"]', extra.lat ?? null, extra.lon ?? null, extra.model ?? null)
    .run();

describe('POST /ingest/species/pending', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM photos').run();
  });

  it('lists local and Google Drive photos that have no species scan yet, with what the agent needs', async () => {
    await insert('l1', { lat: 11.7, lon: 76.6, subjects: '["bird","oriole"]' });
    await insert('g1', { source: 'google_drive', path: null, drive: 'drive-file-1', album: 'B' });
    const page = (await (await pending()).json()) as Page;
    expect(page.items).toEqual([
      { contentHash: 'h-l1', source: 'local', path: '/p/l1.jpg', driveFileId: null, album: 'A', filename: 'l1.jpg', latitude: 11.7, longitude: 76.6, subjects: ['bird', 'oriole'] },
      { contentHash: 'h-g1', source: 'google_drive', path: null, driveFileId: 'drive-file-1', album: 'B', filename: 'g1.jpg', latitude: null, longitude: null, subjects: ['bird'] },
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it('skips photos already scanned with this model but includes ones scanned with another', async () => {
    await insert('done', { model: 'bioclip-2' });
    await insert('old', { model: 'bioclip-1' });
    await insert('new');
    const hashes = ((await (await pending()).json()) as Page).items.map((i) => i.contentHash);
    expect(hashes).toEqual(['h-old', 'h-new']);
  });

  it('skips photos the agent cannot open (no local path, no Drive file id)', async () => {
    await insert('nopath', { path: null });
    await insert('nodrive', { source: 'google_drive', path: null, drive: null });
    await insert('ok');
    expect(((await (await pending()).json()) as Page).items.map((i) => i.contentHash)).toEqual(['h-ok']);
  });

  it('pages with a cursor until nothing is left', async () => {
    for (const id of ['a', 'b', 'c', 'd', 'e']) await insert(id);
    const seen: string[] = [];
    let cursor: number | undefined;
    let pages = 0;
    do {
      const page = (await (await pending({ limit: 2, cursor })).json()) as Page;
      seen.push(...page.items.map((i) => i.contentHash));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor !== undefined);
    expect(seen).toEqual(['h-a', 'h-b', 'h-c', 'h-d', 'h-e']);
    expect(pages).toBe(3);
  });

  it('limits to one album when asked', async () => {
    await insert('a1', { album: 'A' });
    await insert('b1', { album: 'B' });
    const page = (await (await pending({ album: 'B' })).json()) as Page;
    expect(page.items.map((i) => i.contentHash)).toEqual(['h-b1']);
  });

  it('a photo drops off the list once its species are recorded, even when none were found', async () => {
    await insert('x');
    await call('../species', { model: 'bioclip-2', photos: [{ contentHash: 'h-x', species: [] }] });
    expect(((await (await pending()).json()) as Page).items).toEqual([]);
  });

  it('rejects a bad body and needs the ingest token', async () => {
    expect((await pending({ limit: 0 })).status).toBe(400);
    expect((await pending({ limit: 101 })).status).toBe(400);
    expect((await call('pending', { limit: 10 })).status).toBe(400);
    const res = await SELF.fetch('https://example.com/ingest/species/pending', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.READ_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'bioclip-2', limit: 10 }),
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /ingest/species/summary', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM photos').run();
  });

  it('counts photos and photos still to scan per album', async () => {
    await insert('a1', { album: 'A' });
    await insert('a2', { album: 'A', model: 'bioclip-2' });
    await insert('b1', { album: 'B', source: 'google_drive', path: null, drive: 'f' });
    await insert('c1', { album: 'C', path: null });
    const res = await call('summary', { model: 'bioclip-2' });
    expect(await res.json()).toEqual({
      albums: [
        { album: 'A', total: 2, pending: 1 },
        { album: 'B', total: 1, pending: 1 },
        { album: 'C', total: 1, pending: 0 },
      ],
    });
  });

  it('needs a model', async () => {
    expect((await call('summary', {})).status).toBe(400);
  });
});
