import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { embeddingToBytes } from '../src/people/embedding';
import { loadReferences } from '../src/people/references';
import { REFERENCES_PER_PERSON } from '../src/people/matching';

function vec(i: number): Float32Array {
  const v = new Float32Array(512);
  v[i] = 1;
  return v;
}

async function addConfirmed(personId: string, axis: number, createdAt: string, status = 'confirmed') {
  await env.DB.prepare(
    `INSERT INTO faces (id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, det_score, embedding, embedding_model,
       person_id, assign_status, created_at)
     VALUES (?, 'x', 0.1, 0.1, 0.2, 0.2, 0.9, ?, 'buffalo_l', ?, ?, ?)`
  )
    .bind(crypto.randomUUID(), embeddingToBytes(vec(axis)).buffer, personId, status, createdAt)
    .run();
}

describe('loadReferences', () => {
  beforeEach(async () => {
    for (const t of ['faces', 'persons']) await env.DB.prepare(`DELETE FROM ${t}`).run();
    for (const [id, name] of [['p1', 'Anu'], ['p2', 'Bo'], ['p3', 'Cy']]) {
      await env.DB.prepare('INSERT INTO persons (id, name, created_at) VALUES (?, ?, ?)').bind(id, name, 't').run();
    }
  });

  it('returns the newest REFERENCES_PER_PERSON confirmed faces by created_at, per person', async () => {
    for (let i = 0; i < 40; i++) await addConfirmed('p1', i, `2026-01-${String(i + 1).padStart(2, '0')}`);
    await addConfirmed('p1', 100, '2027-01-01', 'auto');
    await addConfirmed('p2', 200, '2026-05-01');
    const refs = await loadReferences(env.DB);
    expect(refs.map((r) => r.personId)).toEqual(['p1', 'p2']);
    const p1 = refs[0].vectors;
    expect(p1).toHaveLength(REFERENCES_PER_PERSON);
    // Newest first: axes 39 down to 10; the auto face (axis 100) and the oldest 10 are excluded.
    expect(p1.map((v) => v.indexOf(1))).toEqual(Array.from({ length: 30 }, (_, i) => 39 - i));
    expect(refs[1].vectors).toHaveLength(1);
    expect(await loadReferences(env.DB, { personId: 'p2' })).toHaveLength(1);
    expect(await loadReferences(env.DB, { personId: 'p3' })).toEqual([]);
  });

  it('the per-person lookup uses idx_faces_person_status_created', async () => {
    const { results } = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT f2.rowid FROM faces f2
       WHERE f2.person_id = ? AND f2.assign_status = 'confirmed'
       ORDER BY f2.created_at DESC, f2.rowid DESC LIMIT 30`
    )
      .bind('p1')
      .all<{ detail: string }>();
    const plan = results.map((r) => r.detail).join('\n');
    expect(plan).toContain('idx_faces_person_status_created');
    expect(plan).not.toContain('USE TEMP B-TREE');
  });

  it('the full query never scans faces', async () => {
    const { results } = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT p.id AS person_id, f.embedding
       FROM persons p
       CROSS JOIN faces f ON f.rowid IN (
         SELECT f2.rowid FROM faces f2
         WHERE f2.person_id = p.id AND f2.assign_status = 'confirmed'
         ORDER BY f2.created_at DESC, f2.rowid DESC LIMIT 30)
       ORDER BY p.id, f.created_at DESC, f.rowid DESC`
    ).all<{ detail: string }>();
    expect(results.map((r) => r.detail).filter((d) => /^SCAN f( |$)/.test(d))).toEqual([]);
  });
});
