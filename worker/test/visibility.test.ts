import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../src/access';
import { PHOTOS_MIGRATION_STATEMENTS } from '../migrations/index';
// @ts-expect-error Vite raw import, resolved by the test runner
import migration0016 from '../migrations/0016_album_shares.sql?raw';
import { canEditFor, canEditPhoto, photoAccess, scopeFor, visibleAlbumsSql } from '../src/db/visibility';

const OWNER: User = { email: 'owner@example.com' };
const ALICE: User = { email: 'alice@example.com' };
const BOB: User = { email: 'bob@example.com' };

const run = (sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params).run();
const insert = (id: string, album: string | null) =>
  run(
    `INSERT INTO photos (id, content_hash, source, filename, album, model_provider, model_name, last_indexed)
     VALUES (?, ?, 'local', 'a.jpg', ?, 'ollama', 'm', '2026-01-01T00:00:00.000Z')`,
    id,
    `h-${id}`,
    album
  );

async function visibleIds(user: User): Promise<string[]> {
  const s = scopeFor(user, 'album');
  const r = await env.DB.prepare(`SELECT id FROM photos WHERE 1 = 1${s.sql} ORDER BY id`).bind(...s.params).all<{ id: string }>();
  return r.results.map((x) => x.id);
}

describe('visibility SQL', () => {
  beforeEach(async () => {
    await run('DELETE FROM photos');
    await insert('own', 'Mine');
    await insert('none', null);
    await insert('alice-own', 'AliceAlbum');
    await insert('shared', 'Shared');
    await insert('bobs', 'BobAlbum');
    await run("UPDATE albums SET owner_email = 'alice@example.com' WHERE name = 'AliceAlbum'");
    await run("UPDATE albums SET owner_email = 'bob@example.com' WHERE name = 'BobAlbum'");
    await insert('ownerless', 'Ownerless');
    await run("UPDATE albums SET owner_email = NULL WHERE name = 'Ownerless'");
    await run(`UPDATE albums SET shared_with = '["alice@example.com"]' WHERE name = 'Shared'`);
  });

  it('an owner sees own and shared albums, never unalbumed photos, ownerless albums or other owners', async () => {
    await run(`UPDATE albums SET shared_with = '["owner@example.com"]' WHERE name = 'BobAlbum'`);
    expect(await visibleIds(OWNER)).toEqual(['bobs', 'own', 'shared']);
  });

  it('a user sees owned and shared albums only, never unalbumed or ownerless photos', async () => {
    expect(await visibleIds(ALICE)).toEqual(['alice-own', 'shared']);
    expect(await visibleIds(BOB)).toEqual(['bobs']);
  });

  it('visibleAlbumsSql lists album names', async () => {
    const v = visibleAlbumsSql(ALICE);
    const r = await env.DB.prepare(`SELECT name FROM albums WHERE name IN ${v.sql} ORDER BY name`).bind(...v.params).all<{ name: string }>();
    expect(r.results.map((x) => x.name)).toEqual(['AliceAlbum', 'Shared']);
  });

  it('a refresh preserves owner_email and shared_with', async () => {
    await insert('shared2', 'Shared');
    await insert('alice2', 'AliceAlbum');
    const rows = (await env.DB.prepare('SELECT name, owner_email, shared_with, photo_count FROM albums').all<any>()).results;
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(by.Shared).toMatchObject({ shared_with: '["alice@example.com"]', photo_count: 2 });
    expect(by.AliceAlbum).toMatchObject({ owner_email: 'alice@example.com', photo_count: 2 });
  });

  it('deleting the last photo removes the album row', async () => {
    await run("DELETE FROM photos WHERE id = 'shared'");
    expect(await env.DB.prepare("SELECT 1 FROM albums WHERE name = 'Shared'").first()).toBeNull();
  });

  it('photoAccess (single-photo point lookup) agrees with scopeFor for every photo and user', async () => {
    await run(`UPDATE albums SET shared_with = '["owner@example.com"]' WHERE name = 'BobAlbum'`);
    for (const user of [OWNER, ALICE, BOB]) {
      const a = photoAccess(user, 'p');
      const seen: string[] = [];
      for (const id of ['alice-own', 'bobs', 'none', 'own', 'ownerless', 'shared']) {
        const row = await env.DB.prepare(`SELECT p.id FROM photos p${a.join} WHERE p.id = ?${a.where}`).bind(id, ...a.params).first();
        if (row) seen.push(id);
      }
      expect(seen).toEqual(await visibleIds(user));
    }
  });

  it('canEditPhoto: only the owner of the photo\'s album', () => {
    expect(canEditPhoto(OWNER, null, null)).toBe(false);
    expect(canEditPhoto(OWNER, 'Mine', null)).toBe(false);
    expect(canEditPhoto(ALICE, 'Mine', 'owner@example.com')).toBe(false);
    expect(canEditPhoto(ALICE, 'AliceAlbum', 'alice@example.com')).toBe(true);
    expect(canEditPhoto(OWNER, 'AliceAlbum', 'alice@example.com')).toBe(false);
  });

  it('canEditFor answers from one query over the user\'s own albums', async () => {
    const can = await canEditFor(env.DB, ALICE);
    expect(can('AliceAlbum')).toBe(true);
    expect(can('Shared')).toBe(false);
    expect(can('Ownerless')).toBe(false);
    expect(can(null)).toBe(false);
  });
});

describe('albums owner index (0016)', () => {
  it('exists as a partial index on owner_email', async () => {
    const row = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_albums_owner_email'").first<{ sql: string }>();
    expect(row?.sql).toMatch(/ON albums \(owner_email\) WHERE owner_email IS NOT NULL/);
  });

  it('is identical in 0016_album_shares.sql and the test statements', () => {
    const stmt = PHOTOS_MIGRATION_STATEMENTS.find((x) => x.includes('idx_albums_owner_email'));
    expect(stmt).toBeDefined();
    expect(migration0016 as string).toContain(stmt);
  });
});

describe('persons ownership (0016)', () => {
  it('has the same statements in 0016_album_shares.sql and the test statements', () => {
    const stmts = PHOTOS_MIGRATION_STATEMENTS.filter((x) => /persons/.test(x) && /owner_email|DROP INDEX/.test(x));
    expect(stmts.length).toBe(5);
    for (const stmt of stmts) expect(migration0016 as string).toContain(stmt.replace(/;$/, ''));
  });
});

describe('lowercase emails on albums (0016)', () => {
  const insertAlbum = (owner: string | null, shared: string | null, name = 'CaseAlbum') =>
    run(
      "INSERT INTO albums (name, photo_count, newest_indexed, cover_photo_id, owner_email, shared_with) VALUES (?, 1, '2026-01-01', 'p', ?, ?)",
      name,
      owner,
      shared
    );

  beforeEach(async () => {
    await run("DELETE FROM albums WHERE name LIKE 'CaseAlbum%'");
  });

  it('accepts lowercase and NULL emails', async () => {
    await insertAlbum('owner@example.com', '["a@example.com","b@example.com"]');
    await insertAlbum(null, null, 'CaseAlbum2');
    const row = await env.DB.prepare("SELECT owner_email FROM albums WHERE name = 'CaseAlbum'").first();
    expect(row).toEqual({ owner_email: 'owner@example.com' });
  });

  it('refuses a mixed-case owner_email or shared_with on insert', async () => {
    await expect(insertAlbum('Owner@Example.com', null)).rejects.toThrow(/lowercase/);
    await expect(insertAlbum(null, '["Viewer@Example.com"]')).rejects.toThrow(/lowercase/);
  });

  it('refuses a mixed-case owner_email or shared_with on update and leaves the row alone', async () => {
    await insertAlbum('owner@example.com', '["a@example.com"]');
    await expect(run("UPDATE albums SET owner_email = 'Owner@Example.com' WHERE name = 'CaseAlbum'")).rejects.toThrow(/lowercase/);
    await expect(run("UPDATE albums SET shared_with = '[\"A@example.com\"]' WHERE name = 'CaseAlbum'")).rejects.toThrow(/lowercase/);
    const row = await env.DB.prepare("SELECT owner_email, shared_with FROM albums WHERE name = 'CaseAlbum'").first();
    expect(row).toEqual({ owner_email: 'owner@example.com', shared_with: '["a@example.com"]' });
  });

  it('does not block the album refresh upsert (it never names those columns)', async () => {
    await insertAlbum('owner@example.com', null);
    await run("UPDATE albums SET photo_count = 5 WHERE name = 'CaseAlbum'");
    const row = await env.DB.prepare("SELECT photo_count, owner_email FROM albums WHERE name = 'CaseAlbum'").first();
    expect(row).toEqual({ photo_count: 5, owner_email: 'owner@example.com' });
  });

  it('has the same trigger SQL in 0016_album_shares.sql and the test statements', () => {
    const stmts = PHOTOS_MIGRATION_STATEMENTS.filter((x) => x.includes('albums_emails_lower_'));
    expect(stmts).toHaveLength(2);
    for (const stmt of stmts) expect(migration0016 as string).toContain(stmt.replace(/;$/, ''));
  });
});
