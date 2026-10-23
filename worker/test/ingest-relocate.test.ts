import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

const post = (body: unknown) =>
  SELF.fetch('https://example.com/ingest/relocate', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.INGEST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const insert = (id: string, source: string, path: string | null) =>
  env.DB.prepare(
    `INSERT INTO photos (id, content_hash, source, path, filename, model_provider, model_name, last_indexed)
     VALUES (?, ?, ?, ?, 'f.jpg', 'ollama', 'm', '2026-09-18T00:00:00.000Z')`
  )
    .bind(id, `h-${id}`, source, path)
    .run();

const paths = async () =>
  Object.fromEntries(
    (await env.DB.prepare('SELECT id, path FROM photos').all<{ id: string; path: string | null }>()).results.map((r) => [r.id, r.path])
  );

describe('POST /ingest/relocate', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM photos').run();
    await insert('a', 'local', '/Volumes/T9/abc/1.jpg');
    await insert('b', 'local', '/Volumes/T9/abc/sub/2.jpg');
    await insert('c', 'local', '/Volumes/T9/abcd/3.jpg');
    await insert('d', 'google_drive', null);
    await insert('e', 'local', '/Volumes/T9/other/4.jpg');
  });

  it('rewrites the prefix on whole path segments only', async () => {
    const res = await post({ from: '/Volumes/T9/abc', to: '/Volumes/T9/xyz' });
    expect(await res.json()).toEqual({ matched: 2, updated: 2 });
    expect(await paths()).toEqual({
      a: '/Volumes/T9/xyz/1.jpg',
      b: '/Volumes/T9/xyz/sub/2.jpg',
      c: '/Volumes/T9/abcd/3.jpg',
      d: null,
      e: '/Volumes/T9/other/4.jpg',
    });
  });

  it('accepts trailing slashes', async () => {
    await post({ from: '/Volumes/T9/abc/', to: '/Volumes/T9/xyz/' });
    expect((await paths()).a).toBe('/Volumes/T9/xyz/1.jpg');
  });

  it('does not touch LIKE wildcards in names', async () => {
    await insert('f', 'local', '/Volumes/T9/a_c/5.jpg');
    const res = await post({ from: '/Volumes/T9/a_c', to: '/Volumes/T9/z' });
    expect(await res.json()).toEqual({ matched: 1, updated: 1 });
    expect((await paths()).a).toBe('/Volumes/T9/abc/1.jpg');
  });

  it('dryRun counts without writing', async () => {
    const res = await post({ from: '/Volumes/T9/abc', to: '/Volumes/T9/xyz', dryRun: true });
    expect(await res.json()).toEqual({ matched: 2, updated: 0 });
    expect((await paths()).a).toBe('/Volumes/T9/abc/1.jpg');
  });

  it('rejects relative paths and the filesystem root', async () => {
    expect((await post({ from: 'abc', to: '/x' })).status).toBe(400);
    expect((await post({ from: '/', to: '/x' })).status).toBe(400);
  });

  it('requires the ingest token', async () => {
    const res = await SELF.fetch('https://example.com/ingest/relocate', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });
});
