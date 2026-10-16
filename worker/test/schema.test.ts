import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('photos schema', () => {
  it('accepts an insert and is searchable via photos_fts', async () => {
    await env.DB.prepare(
      `INSERT INTO photos
         (id, content_hash, source, filename, subjects, tags, description,
          environment, album, model_provider, model_name, search_text, last_indexed)
       VALUES (?, ?, 'local', 'leopard.jpg', '["leopard"]', '["leopard","big cat"]',
               'A leopard resting in a tree', 'forest', 'Kanha', 'ollama',
               'qwen3.5:27b-mlx', 'leopard big cat leopard resting tree forest kanha',
               '2026-09-18T00:00:00.000Z')`
    )
      .bind('photo-1', 'hash-1')
      .run();

    const row = await env.DB.prepare('SELECT * FROM photos WHERE id = ?')
      .bind('photo-1')
      .first();
    expect(row?.filename).toBe('leopard.jpg');

    const match = await env.DB.prepare(
      `SELECT photos.id FROM photos
       JOIN photos_fts ON photos.rowid = photos_fts.rowid
       WHERE photos_fts MATCH 'leopard'`
    ).all<{ id: string }>();
    expect(match.results.map((r) => r.id)).toEqual(['photo-1']);
  });
});

describe('people schema', () => {
  const insertFace = (id: string, status?: string) =>
    env.DB.prepare(
      `INSERT INTO faces
         (id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, det_score, embedding, embedding_model, created_at${status ? ', assign_status' : ''})
       VALUES (?, 'photo-x', 0.1, 0.2, 0.3, 0.4, 0.99, x'00', 'arcface', '2026-10-16T00:00:00.000Z'${status ? ', ?' : ''})`
    ).bind(...(status ? [id, status] : [id]));

  it('people schema accepts a face and enforces unique person names case-insensitively', async () => {
    await env.DB.prepare(
      "INSERT INTO persons (id, name, created_at) VALUES ('p1', 'Priya', '2026-10-16T00:00:00.000Z')"
    ).run();
    await insertFace('f-ok').run();
    const face = await env.DB.prepare('SELECT * FROM faces WHERE id = ?').bind('f-ok').first();
    expect(face?.bbox_w).toBe(0.3);
    await env.DB.prepare('UPDATE faces SET person_id = ? WHERE id = ?').bind('p1', 'f-ok').run();

    await expect(
      env.DB.prepare(
        "INSERT INTO persons (id, name, created_at) VALUES ('p2', 'priya', '2026-10-16T00:00:00.000Z')"
      ).run()
    ).rejects.toThrow();
  });

  it('face_rejections primary key rejects a duplicate pair', async () => {
    await env.DB.prepare("INSERT INTO face_rejections (face_id, person_id) VALUES ('f1', 'p1')").run();
    await expect(
      env.DB.prepare("INSERT INTO face_rejections (face_id, person_id) VALUES ('f1', 'p1')").run()
    ).rejects.toThrow();
  });

  it('faces.assign_status defaults to unassigned and rejects an unknown status', async () => {
    await insertFace('f-default').run();
    const row = await env.DB.prepare('SELECT assign_status FROM faces WHERE id = ?')
      .bind('f-default')
      .first<{ assign_status: string }>();
    expect(row?.assign_status).toBe('unassigned');
    await expect(insertFace('f-bad', 'bogus').run()).rejects.toThrow();
  });

  it('photos has a nullable faces_scanned_model column', async () => {
    const cols = await env.DB.prepare('PRAGMA table_info(photos)').all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).toContain('faces_scanned_model');
  });
});
