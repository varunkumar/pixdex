import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseFraming } from '../src/db/framing';
// @ts-expect-error Vite raw import, resolved by the test runner
import migration0021 from '../migrations/0021_album_framing.sql?raw';
import { PHOTOS_MIGRATION_STATEMENTS } from '../migrations/index';
import { OWNER_TEST_EMAIL, readHeaders } from './helpers';

const OWNER = OWNER_TEST_EMAIL;
const VIEWER = 'viewer@example.com';
const STRANGER = 'stranger@example.com';

const run = (sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params).run();
const send = (method: string, path: string, as: string, body?: unknown) =>
  SELF.fetch(`https://example.com${path}`, {
    method,
    headers: { ...readHeaders(as), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const hashOf = (id: string) => `hash-${id}-0123456789`;

async function insertPhoto(id: string, album: string, dateTime = '2026-03-05T10:00:00') {
  await run(
    `INSERT INTO photos (id, content_hash, source, filename, album, date_time, model_provider, model_name, last_indexed)
     VALUES (?, ?, 'local', 'a.jpg', ?, ?, 'ollama', 'm', '2026-01-01T00:00:00.000Z')`,
    id,
    hashOf(id),
    album,
    dateTime
  );
}

const column = async (album = 'Kanha') =>
  (await env.DB.prepare('SELECT cover_framing FROM albums WHERE name = ?').bind(album).first<{ cover_framing: string | null }>())!.cover_framing;
const listed = async (as: string, album = 'Kanha') => {
  const res = await send('GET', `/albums?limit=1&name=${album}`, as);
  return (await res.json<{ albums: { coverPhotoId: string; coverFraming: unknown }[] }>()).albums[0];
};
const setCover = (photoId: string) => send('PUT', '/albums/cover', OWNER, { album: 'Kanha', photoId });

const FRAMING = { x: 20, y: 70, zoom: 1.5 };
const body = (over: Record<string, unknown> = {}) => ({ album: 'Kanha', contentHash: hashOf('k1'), ...FRAMING, ...over });
const put = (as: string, over: Record<string, unknown> = {}) => send('PUT', '/albums/framing', as, body(over));

beforeEach(async () => {
  await run('DELETE FROM photos');
  await run('DELETE FROM album_covers');
  await insertPhoto('k1', 'Kanha');
  await insertPhoto('k2', 'Kanha', '2026-03-04T10:00:00');
  await insertPhoto('s1', 'Sundarbans');
  await run(`UPDATE albums SET shared_with = '["viewer@example.com"]' WHERE name = 'Kanha'`);
  expect((await setCover('k1')).status).toBe(200);
});

describe('PUT /albums/framing', () => {
  it('saves the framing, and the owner and a viewer both get it', async () => {
    const res = await put(OWNER);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ album: 'Kanha', coverFraming: FRAMING });
    expect(JSON.parse((await column())!)).toEqual({ hash: hashOf('k1'), ...FRAMING });
    expect((await listed(OWNER)).coverFraming).toEqual(FRAMING);
    expect((await listed(VIEWER)).coverFraming).toEqual(FRAMING);
  });

  it('an unframed album has coverFraming null', async () => {
    expect((await listed(OWNER, 'Sundarbans')).coverFraming).toBeNull();
    expect((await listed(OWNER)).coverFraming).toBeNull();
  });

  it('accepts the range limits', async () => {
    expect((await put(OWNER, { x: 0, y: 100, zoom: 3 })).status).toBe(200);
    expect((await listed(OWNER)).coverFraming).toEqual({ x: 0, y: 100, zoom: 3 });
  });

  it('gives a viewer 403 and a stranger or unknown album 404, unchanged', async () => {
    await put(OWNER);
    const before = await column();
    expect((await put(VIEWER, { x: 1 })).status).toBe(403);
    expect((await put(STRANGER, { x: 1 })).status).toBe(404);
    expect((await put(OWNER, { album: 'Nope' })).status).toBe(404);
    expect(await column()).toBe(before);
  });

  it.each([
    ['x below 0', { x: -1 }],
    ['x above 100', { x: 101 }],
    ['y below 0', { y: -1 }],
    ['y above 100', { y: 101 }],
    ['zoom below 1', { zoom: 0.9 }],
    ['zoom above 3', { zoom: 3.1 }],
    ['a missing album', { album: undefined }],
    ['an empty album', { album: '' }],
    ['a missing contentHash', { contentHash: undefined }],
    ['a missing x', { x: undefined }],
    ['a missing y', { y: undefined }],
    ['a missing zoom', { zoom: undefined }],
    ['a string number', { x: '20' }],
  ])('400 for %s', async (_name, over) => {
    expect((await put(OWNER, over)).status).toBe(400);
    expect(await column()).toBeNull();
  });

  it('400 for a body that is not JSON', async () => {
    const res = await SELF.fetch('https://example.com/albums/framing', {
      method: 'PUT',
      headers: { ...readHeaders(OWNER), 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(res.status).toBe(400);
  });

  it("409 for a contentHash that is not the cover's, unchanged", async () => {
    await put(OWNER);
    const before = await column();
    expect((await put(OWNER, { contentHash: hashOf('k2'), x: 1 })).status).toBe(409);
    expect((await put(OWNER, { contentHash: hashOf('k2'), x: 50, y: 50, zoom: 1 })).status).toBe(409);
    expect(await column()).toBe(before);
  });

  it('stores NULL for the centre at 1x', async () => {
    await put(OWNER);
    const res = await put(OWNER, { x: 50, y: 50, zoom: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ album: 'Kanha', coverFraming: null });
    expect(await column()).toBeNull();
    expect((await listed(OWNER)).coverFraming).toBeNull();
  });

  it('applies only to the cover it was saved for', async () => {
    await put(OWNER);
    expect((await setCover('k2')).status).toBe(200);
    expect(await listed(OWNER)).toMatchObject({ coverPhotoId: 'k2', coverFraming: null });
    expect((await setCover('k1')).status).toBe(200);
    expect((await listed(OWNER)).coverFraming).toEqual(FRAMING);
  });

  it('keeps the column when another photo joins the album', async () => {
    await put(OWNER);
    const before = await column();
    await insertPhoto('k3', 'Kanha', '2026-04-01T10:00:00');
    expect(await column()).toBe(before);
    expect((await listed(OWNER)).coverFraming).toEqual(FRAMING);
  });

  it('returns null for invalid JSON in the column', async () => {
    await run("UPDATE albums SET cover_framing = '{nope' WHERE name = 'Kanha'");
    expect((await send('GET', '/albums?limit=1&name=Kanha', OWNER)).status).toBe(200);
    expect((await listed(OWNER)).coverFraming).toBeNull();
  });
});

describe('parseFraming', () => {
  const raw = (v: unknown) => JSON.stringify(v);

  it('returns x, y and zoom for the matching hash only', () => {
    expect(parseFraming(raw({ hash: 'h', ...FRAMING }), 'h')).toEqual(FRAMING);
    expect(parseFraming(raw({ hash: 'h', ...FRAMING }), 'other')).toBeNull();
    expect(parseFraming(raw({ hash: 'h', ...FRAMING }), null)).toBeNull();
    expect(parseFraming(raw(FRAMING), null)).toBeNull();
    expect(parseFraming(null, 'h')).toBeNull();
  });

  it.each([
    ['null'],
    ['[]'],
    ['3'],
    [raw({ hash: 'h', x: 20, y: 70 })],
    [raw({ hash: 'h', x: '20', y: 70, zoom: 1 })],
    [raw({ hash: 'h', x: 101, y: 70, zoom: 1 })],
    [raw({ hash: 'h', x: 20, y: 70, zoom: 4 })],
  ])('returns null for %s', (value) => {
    expect(parseFraming(value, 'h')).toBeNull();
  });
});

describe('migration 0021', () => {
  it('has the same statement in the SQL file and the test statements', () => {
    const stmt = 'ALTER TABLE albums ADD COLUMN cover_framing TEXT;';
    expect(migration0021 as string).toContain(stmt);
    expect(PHOTOS_MIGRATION_STATEMENTS).toContain(stmt);
  });
});
