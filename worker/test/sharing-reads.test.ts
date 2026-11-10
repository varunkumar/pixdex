import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { OWNER_TEST_EMAIL, readHeaders } from './helpers';

const OWNER = OWNER_TEST_EMAIL;
const VIEWER = 'viewer@example.com';
const STRANGER = 'stranger@example.com';

const run = (sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params).run();
const get = (path: string, as: string) => SELF.fetch(`https://example.com${path}`, { headers: readHeaders(as) });
const json = async (path: string, as: string) => (await get(path, as)).json<any>();
const ids = async (path: string, as: string) => (await json(path, as)).results.map((p: { id: string }) => p.id).sort();

async function insert(id: string, album: string | null, dateTime: string) {
  await run(
    `INSERT INTO photos (id, content_hash, source, filename, album, date_time, model_provider, model_name, last_indexed)
     VALUES (?, ?, 'local', 'a.jpg', ?, ?, 'ollama', 'm', '2026-01-01T00:00:00.000Z')`,
    id,
    `hash-${id}-0123456789`,
    album,
    dateTime
  );
  await env.THUMBNAILS.put(`hash-${id}-0123456789.jpg`, new Uint8Array([1, 2, 3]));
}

describe('album sharing: scoped photo reads', () => {
  beforeEach(async () => {
    await run('DELETE FROM faces');
    await run('DELETE FROM photos');
    await insert('kanha', 'Kanha', '2026-03-05T10:00:00');
    await insert('ranth', 'Ranthambore', '2026-03-06T10:00:00');
    await insert('none', null, '2026-02-01T10:00:00');
    await insert('sundar', 'Sundarbans', '2026-03-07T10:00:00');
    // Month zoom only shows rated photos.
    await run('UPDATE photos SET aesthetic_score = 8');
    await run(`UPDATE albums SET shared_with = '["viewer@example.com"]' WHERE name = 'Kanha'`);
    await run("UPDATE albums SET owner_email = 'other@example.com' WHERE name = 'Sundarbans'");
    // Kanha and Ranthambore stay owned by the default owner (owner_email NULL).
    for (const photo of ['kanha', 'ranth']) {
      await run(
        `INSERT INTO faces (id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, det_score, embedding, embedding_model, crop_key, created_at)
         VALUES (?, ?, 0, 0, 1, 1, 0.9, x'00', 'm', ?, '2026-01-01T00:00:00.000Z')`,
        `face-${photo}`,
        photo,
        `crops/${photo}.jpg`
      );
      await env.THUMBNAILS.put(`crops/${photo}.jpg`, new Uint8Array([9]));
    }
  });

  describe('/search', () => {
    it('shows the default owner Kanha, Ranthambore and the unalbumed photo, not other owners', async () => {
      const body = await json('/search', OWNER);
      expect(body.results.map((p: any) => p.id).sort()).toEqual(['kanha', 'none', 'ranth']);
      expect(body.total).toBe(3);
    });

    it('shows a viewer only the shared album and counts only visible rows', async () => {
      const body = await json('/search', VIEWER);
      expect(body.results.map((p: any) => p.id)).toEqual(['kanha']);
      expect(body.total).toBe(1);
    });

    it('shows a stranger nothing and does not leak the global total', async () => {
      const body = await json('/search', STRANGER);
      expect(body).toEqual({ results: [], total: 0 });
    });

    it('applies the scope with a text query and with an album filter', async () => {
      await run("UPDATE photos SET search_text = 'leopard'");
      await run("INSERT INTO photos_fts(photos_fts) VALUES ('rebuild')");
      expect(await ids('/search?q=leopard', VIEWER)).toEqual(['kanha']);
      expect(await ids('/search?q=leopard', STRANGER)).toEqual([]);
      expect(await ids('/search?album=Kanha', VIEWER)).toEqual(['kanha']);
      const hidden = await json('/search?album=Ranthambore', VIEWER);
      expect(hidden).toEqual({ results: [], total: 0 });
      expect(await ids('/search?album=Sundarbans', OWNER)).toEqual([]);
      expect(await ids('/search?album=Ranthambore', OWNER)).toEqual(['ranth']);
    });

    it('sets canEdit only where the user owns the album', async () => {
      const owner = (await json('/search', OWNER)).results;
      expect(owner.every((p: any) => p.canEdit === true)).toBe(true);
      const viewer = (await json('/search', VIEWER)).results;
      expect(viewer.map((p: any) => p.canEdit)).toEqual([false]);
    });
  });

  describe('/timeline', () => {
    const group = (body: any) => body.groups.flatMap((g: any) => g.photos.map((p: any) => p.id)).sort();

    it('scopes month and day zoom and the group totals', async () => {
      for (const zoom of ['month', 'day']) {
        const owner = await json(`/timeline?zoom=${zoom}`, OWNER);
        expect(group(owner)).toEqual(['kanha', 'none', 'ranth']);
        const viewer = await json(`/timeline?zoom=${zoom}`, VIEWER);
        expect(group(viewer)).toEqual(['kanha']);
        expect(viewer.groups.reduce((n: number, g: any) => n + g.total, 0)).toBe(1);
        expect(viewer.groups.flatMap((g: any) => g.photos).every((p: any) => p.canEdit === false)).toBe(true);
        expect((await json(`/timeline?zoom=${zoom}`, STRANGER)).groups).toEqual([]);
      }
    });

    it('a hidden album filter returns no groups', async () => {
      expect((await json('/timeline?zoom=day&album=Ranthambore', VIEWER)).groups).toEqual([]);
    });

    it('/timeline/buckets counts only visible photos', async () => {
      expect(await json('/timeline/buckets', OWNER)).toEqual({
        buckets: [
          { month: '2026-03', total: 2 },
          { month: '2026-02', total: 1 },
        ],
        undated: 0,
      });
      expect(await json('/timeline/buckets', VIEWER)).toEqual({ buckets: [{ month: '2026-03', total: 1 }], undated: 0 });
      expect(await json('/timeline/buckets', STRANGER)).toEqual({ buckets: [], undated: 0 });
    });
  });

  describe('/albums', () => {
    it('lists only visible names', async () => {
      expect((await json('/albums', OWNER)).albums).toEqual(['Kanha', 'Ranthambore']);
      expect((await json('/albums?names=1', VIEWER)).albums).toEqual(['Kanha']);
      expect((await json('/albums', STRANGER)).albums).toEqual([]);
    });

    it('pages visible albums with role, total and sharedWith for owned albums only', async () => {
      const owner = await json('/albums?limit=12&sort=name', OWNER);
      expect(owner.total).toBe(2);
      expect(owner.albums.map((a: any) => [a.name, a.role, a.sharedWith])).toEqual([
        ['Kanha', 'owner', ['viewer@example.com']],
        ['Ranthambore', 'owner', []],
      ]);
      const viewer = await json('/albums?limit=12', VIEWER);
      expect(viewer.total).toBe(1);
      expect(viewer.albums).toHaveLength(1);
      expect(viewer.albums[0]).toMatchObject({ name: 'Kanha', role: 'viewer' });
      expect('sharedWith' in viewer.albums[0]).toBe(false);
      expect(await json('/albums?limit=12', STRANGER)).toEqual({ albums: [], total: 0 });
    });
  });

  describe('single resources', () => {
    it('/photos/:id is 404 for hidden photos and carries canEdit', async () => {
      expect((await get('/photos/kanha', VIEWER)).status).toBe(200);
      expect((await json('/photos/kanha', VIEWER)).canEdit).toBe(false);
      expect((await json('/photos/kanha', OWNER)).canEdit).toBe(true);
      expect((await json('/photos/none', OWNER)).canEdit).toBe(true);
      expect((await get('/photos/ranth', VIEWER)).status).toBe(404);
      expect((await get('/photos/none', VIEWER)).status).toBe(404);
      expect((await get('/photos/sundar', OWNER)).status).toBe(404);
      expect((await get('/photos/kanha', STRANGER)).status).toBe(404);
    });

    it('/photos/:id hides the owner\'s path and Drive file id from viewers', async () => {
      await run("UPDATE photos SET path = '/Users/owner/Pictures/k.jpg', drive_file_id = 'drive-k' WHERE id = 'kanha'");
      const viewer = await json('/photos/kanha', VIEWER);
      expect(viewer.path).toBeNull();
      expect(viewer.driveFileId).toBeNull();
      const owner = await json('/photos/kanha', OWNER);
      expect(owner.path).toBe('/Users/owner/Pictures/k.jpg');
      expect(owner.driveFileId).toBe('drive-k');
    });

    it('/photos/:id/faces is 404 for hidden photos', async () => {
      expect((await get('/photos/kanha/faces', VIEWER)).status).toBe(200);
      expect((await get('/photos/ranth/faces', VIEWER)).status).toBe(404);
      expect((await get('/photos/kanha/faces', STRANGER)).status).toBe(404);
    });

    it('/thumbnails/:hash is 404 for hidden photos and private-cached when visible', async () => {
      const ok = await get('/thumbnails/hash-kanha-0123456789', VIEWER);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
      expect((await get('/thumbnails/hash-ranth-0123456789', VIEWER)).status).toBe(404);
      expect((await get('/thumbnails/hash-kanha-0123456789', STRANGER)).status).toBe(404);
      expect((await get('/thumbnails/hash-ranth-0123456789', OWNER)).status).toBe(200);
    });

    it('serves the default owner a thumbnail with no photo row, and gates other users on a visible photo', async () => {
      await env.THUMBNAILS.put('orphan-hash-0123456789.jpg', new Uint8Array([7]));
      expect((await get('/thumbnails/orphan-hash-0123456789', OWNER)).status).toBe(200);
      expect((await get('/thumbnails/orphan-hash-0123456789', VIEWER)).status).toBe(404);
      await run(`UPDATE albums SET shared_with = '[]' WHERE name = 'Kanha'`);
      expect((await get('/thumbnails/hash-kanha-0123456789', VIEWER)).status).toBe(404);
      await run(`UPDATE albums SET shared_with = '["viewer@example.com"]' WHERE name = 'Kanha'`);
      expect((await get('/thumbnails/hash-kanha-0123456789', VIEWER)).status).toBe(200);
    });

    it('/faces/:id/crop is 404 for hidden photos', async () => {
      expect((await get('/faces/face-kanha/crop', VIEWER)).status).toBe(200);
      expect((await get('/faces/face-ranth/crop', VIEWER)).status).toBe(404);
      expect((await get('/faces/face-kanha/crop', STRANGER)).status).toBe(404);
      expect((await get('/faces/face-ranth/crop', OWNER)).status).toBe(200);
    });
  });

  describe('a non-default owner', () => {
    const OTHER = 'other@example.com';

    it('sees and may edit their own album, and sees sharedWith only for it', async () => {
      await run(`UPDATE albums SET shared_with = '["viewer@example.com"]' WHERE name = 'Sundarbans'`);
      const search = await json('/search', OTHER);
      expect(search.results.map((p: any) => [p.id, p.canEdit])).toEqual([['sundar', true]]);
      expect((await json('/photos/sundar', OTHER)).canEdit).toBe(true);
      expect((await get('/photos/kanha', OTHER)).status).toBe(404);
      const albums = await json('/albums?limit=12', OTHER);
      expect(albums.total).toBe(1);
      expect(albums.albums[0]).toMatchObject({ name: 'Sundarbans', role: 'owner', sharedWith: ['viewer@example.com'] });
      const viewer = await json('/albums?limit=12', VIEWER);
      const sundar = viewer.albums.find((a: any) => a.name === 'Sundarbans');
      expect(sundar.role).toBe('viewer');
      expect('sharedWith' in sundar).toBe(false);
    });
  });

  describe('single-user state (no album has an owner_email)', () => {
    it('the default owner still sees every album and the counters total', async () => {
      await run('UPDATE albums SET owner_email = NULL');
      expect((await json('/albums', OWNER)).albums).toEqual(['Kanha', 'Ranthambore', 'Sundarbans']);
      const page = await json('/albums?limit=12&sort=name', OWNER);
      expect(page.total).toBe(3);
      expect(page.albums.map((a: any) => a.name)).toEqual(['Kanha', 'Ranthambore', 'Sundarbans']);
      expect((await json('/search', OWNER)).total).toBe(4);
      expect((await json('/albums?limit=12&name=Kanha', OWNER)).albums).toHaveLength(1);
    });
  });
});
