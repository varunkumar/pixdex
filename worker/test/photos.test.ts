import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

describe('GET /photos/:id', () => {
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

});

describe('GET /albums', () => {
  async function insert(
    id: string,
    hash: string,
    album: string | null,
    dateTime: string | null,
    lastIndexed = '2026-09-18T00:00:00.000Z'
  ) {
    await env.DB.prepare(
      `INSERT INTO photos (id, content_hash, source, filename, album, date_time, model_provider, model_name, last_indexed)
       VALUES (?,?,'local',?,?,?,'ollama','qwen3.5:27b-mlx',?)`
    )
      .bind(id, hash, `${id}.jpg`, album, dateTime, lastIndexed)
      .run();
  }

  async function get(query = '?limit=12') {
    const response = await SELF.fetch(`https://example.com/albums${query}`, {
      headers: { Authorization: `Bearer ${env.READ_TOKEN}` },
    });
    return (await response.json()) as any;
  }

  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM photos').run();
  });

  it('returns rich albums with count, newest-photo cover and total', async () => {
    await insert('k-old', 'h-k-old', 'Kanha', '2026-01-01T00:00:00.000Z');
    await insert('k-new', 'h-k-new', 'Kanha', '2026-03-01T00:00:00.000Z');
    await insert('z-1', 'h-z-1', 'Kaziranga', '2026-02-01T00:00:00.000Z');
    await insert('loose', 'h-loose', null, '2026-04-01T00:00:00.000Z');

    const body = await get();
    expect(body.total).toBe(2);
    expect(body.albums).toEqual([
      {
        name: 'Kanha',
        photoCount: 2,
        coverPhotoId: 'k-new',
        coverThumbnailUrl: '/thumbnails/h-k-new',
        latestDate: '2026-03-01T00:00:00.000Z',
      },
      {
        name: 'Kaziranga',
        photoCount: 1,
        coverPhotoId: 'z-1',
        coverThumbnailUrl: '/thumbnails/h-z-1',
        latestDate: '2026-02-01T00:00:00.000Z',
      },
    ]);
  });

  it('paginates with limit and offset while total stays the album count', async () => {
    await insert('a', 'h-a', 'A', '2026-03-01T00:00:00.000Z');
    await insert('b', 'h-b', 'B', '2026-02-01T00:00:00.000Z');
    await insert('c', 'h-c', 'C', '2026-01-01T00:00:00.000Z');

    const page = await get('?limit=1&offset=1');
    expect(page.total).toBe(3);
    expect(page.albums.map((a: { name: string }) => a.name)).toEqual(['B']);
  });

  it('falls back to last_indexed for ordering when date_time is null and reports a null latestDate', async () => {
    await insert('n-1', 'h-n-1', 'Undated', null, '2026-09-01T00:00:00.000Z');
    await insert('d-1', 'h-d-1', 'Dated', '2026-01-01T00:00:00.000Z');

    const body = await get();
    expect(body.albums.map((a: { name: string }) => a.name)).toEqual(['Undated', 'Dated']);
    expect(body.albums[0].latestDate).toBeNull();
  });

  it('clamps limit to 48 and a negative offset to 0', async () => {
    await insert('a', 'h-a', 'A', '2026-03-01T00:00:00.000Z');
    const body = await get('?limit=9999&offset=-5');
    expect(body.albums).toHaveLength(1);
  });

  it('returns an empty page for an empty library', async () => {
    expect(await get()).toEqual({ albums: [], total: 0 });
  });

  it('names=1 returns the plain list of names for dropdowns', async () => {
    await insert('b', 'h-b', 'Beta', '2026-02-01T00:00:00.000Z');
    await insert('a', 'h-a', 'Alpha', '2026-03-01T00:00:00.000Z');
    expect(await get('?names=1')).toEqual({ albums: ['Alpha', 'Beta'] });
  });

  it('bare /albums keeps the legacy list of names so an older frontend keeps working', async () => {
    await insert('a', 'h-a', 'Alpha', '2026-03-01T00:00:00.000Z');
    expect(await get('')).toEqual({ albums: ['Alpha'] });
  });

  it('for a mixed album, latestDate is the newest real photo date and the cover is a dated photo', async () => {
    await insert('shot-2019', 'h-2019', 'Mixed', '2019-05-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    await insert('screenshot', 'h-shot', 'Mixed', null, '2026-09-18T00:00:00.000Z');
    await insert('other', 'h-other', 'Other', '2024-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

    const body = await get();
    const mixed = body.albums.find((a: { name: string }) => a.name === 'Mixed');
    expect(mixed.coverPhotoId).toBe('shot-2019');
    expect(mixed.latestDate).toBe('2019-05-01T00:00:00.000Z');
    expect(mixed.photoCount).toBe(2);
    // Ordered by newest real photo date: Other (2024) before Mixed (2019).
    expect(body.albums.map((a: { name: string }) => a.name)).toEqual(['Other', 'Mixed']);
  });
});
