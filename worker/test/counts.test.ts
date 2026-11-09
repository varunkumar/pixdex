import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { albumsMigrationSql } from '../migrations/albums';
// @ts-expect-error Vite raw import, resolved by the test runner
import migrationFile from '../migrations/0015_albums.sql?raw';

const insert = (id: string, album: string | null, dateTime: string | null = null, indexed = '2026-01-01T00:00:00.000Z') =>
  env.DB.prepare(
    `INSERT INTO photos (id, content_hash, source, filename, album, date_time, model_provider, model_name, last_indexed)
     VALUES (?, ?, 'local', 'a.jpg', ?, ?, 'ollama', 'm', ?)`
  )
    .bind(id, `h-${id}`, album, dateTime, indexed)
    .run();

const run = (sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params).run();
const rows = async () => (await env.DB.prepare('SELECT * FROM albums ORDER BY name').all<any>()).results;
const total = async () => (await env.DB.prepare("SELECT n FROM counters WHERE name = 'photos'").first<{ n: number }>())?.n;

describe('migration file', () => {
  it('matches what albums.ts generates (run npm run gen:albums-migration)', () => {
    expect(migrationFile).toBe(albumsMigrationSql());
  });
});

describe('trigger-maintained albums and counters', () => {
  beforeEach(async () => {
    await run('DELETE FROM photos');
    await run('DELETE FROM album_covers');
  });

  it('keeps count, newest date, cover and its thumbnail hash', async () => {
    await insert('old', 'A', '2020-01-01');
    await insert('new', 'A', '2024-05-05');
    await insert('none', null);
    const [a] = await rows();
    expect(a).toMatchObject({
      name: 'A',
      photo_count: 2,
      latest_date: '2024-05-05',
      cover_photo_id: 'new',
      content_hash: 'h-new',
      avg_score: null,
    });
    expect(await total()).toBe(3);
  });

  it('falls back to the newest indexed photo when none is dated', async () => {
    await insert('x', 'A', null, '2026-01-01T00:00:00.000Z');
    await insert('y', 'A', null, '2026-02-01T00:00:00.000Z');
    expect((await rows())[0]).toMatchObject({ cover_photo_id: 'y', latest_date: null, newest_indexed: '2026-02-01T00:00:00.000Z' });
  });

  it('follows rating changes and cover picks, and drops a pick that left the album', async () => {
    await insert('1', 'A', '2024-01-01');
    await insert('2', 'A', '2023-01-01');
    await run('UPDATE photos SET user_rating = 5 WHERE id = ?', '1');
    expect((await rows())[0].avg_score).toBeCloseTo(10);
    await run('UPDATE photos SET aesthetic_score = 6 WHERE id = ?', '2');
    expect((await rows())[0].avg_score).toBeCloseTo(8);

    await run('INSERT INTO album_covers (album, photo_id) VALUES (?, ?)', 'A', '2');
    expect((await rows())[0].cover_photo_id).toBe('2');
    await run('UPDATE album_covers SET photo_id = ? WHERE album = ?', '1', 'A');
    expect((await rows())[0].cover_photo_id).toBe('1');
    await run("UPDATE photos SET album = 'B' WHERE id = '1'");
    expect((await rows()).map((r: any) => [r.name, r.cover_photo_id])).toEqual([['A', '2'], ['B', '1']]);
    await run('DELETE FROM album_covers WHERE album = ?', 'A');
    expect((await rows())[0].cover_photo_id).toBe('2');
  });

  it('moves a photo between albums and drops emptied albums', async () => {
    await insert('1', 'A');
    await insert('2', 'B');
    await run("UPDATE photos SET album = 'B' WHERE id = '1'");
    expect((await rows()).map((r: any) => [r.name, r.photo_count])).toEqual([['B', 2]]);
    await run("UPDATE photos SET album = NULL WHERE id = '1'");
    await run("UPDATE photos SET album = 'C' WHERE id = '2'");
    expect((await rows()).map((r: any) => [r.name, r.photo_count])).toEqual([['C', 1]]);
    expect(await total()).toBe(2);
  });

  it('leaves counts alone on an upsert that keeps the album, and tracks an upsert that moves it', async () => {
    await insert('1', 'A');
    await run("UPDATE photos SET album = 'A', filename = 'b.jpg' WHERE id = '1'");
    expect((await rows())[0].photo_count).toBe(1);
    await run("UPDATE photos SET album = 'Z', date_time = '2025-01-01' WHERE id = '1'");
    expect((await rows()).map((r: any) => [r.name, r.latest_date])).toEqual([['Z', '2025-01-01']]);
  });

  it('empties everything on delete', async () => {
    await insert('1', 'A');
    await insert('2', null);
    await run('DELETE FROM photos');
    expect(await rows()).toEqual([]);
    expect(await total()).toBe(0);
  });

  it('browses the unfiltered list by last_indexed with the index', async () => {
    const plan = await env.DB.prepare(
      'EXPLAIN QUERY PLAN SELECT photos.* FROM photos WHERE 1=1 ORDER BY last_indexed DESC LIMIT 20 OFFSET 0'
    ).all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join(' ')).toContain('idx_photos_last_indexed');
  });
});
