import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { embeddingToBytes } from '../src/people/embedding';
import {
  REFERENCES_CACHE_TTL_MS,
  clearReferencesCache,
  loadReferences,
  loadReferencesCached,
  referencesSql,
} from '../src/people/references';

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

  it("returns each person's reference faces", async () => {
    await addConfirmed('p1', 1, '2026-01-01');
    await addConfirmed('p1', 2, '2026-01-02');
    await addConfirmed('p1', 100, '2027-01-01', 'auto');
    await addConfirmed('p2', 200, '2026-05-01');
    const refs = await loadReferences(env.DB);
    expect(refs.map((r) => r.personId)).toEqual(['p1', 'p2']);
    expect(refs[0].vectors.map((v) => v.indexOf(1)).sort()).toEqual([1, 2]);
    expect(refs[1].vectors).toHaveLength(1);
    expect(await loadReferences(env.DB, { personId: 'p2' })).toHaveLength(1);
    expect(await loadReferences(env.DB, { personId: 'p3' })).toEqual([]);
  });

  it.each(['', 'WHERE p.id = ?', 'WHERE p.owner_email = ?'])('reads rows and faces by key (%s)', async (where) => {
    const statement = env.DB.prepare(`EXPLAIN QUERY PLAN ${referencesSql(where)}`);
    const { results } = await (where ? statement.bind('x') : statement).all<{ detail: string }>();
    const plan = results.map((r) => r.detail).join('\n');
    expect(plan).toMatch(/SEARCH r USING PRIMARY KEY \(person_id=\?\)/);
    expect(plan).toMatch(/SEARCH f USING INDEX sqlite_autoindex_faces_1 \(id=\?\)/);
    expect(plan).not.toMatch(/SCAN (f|r)\b/);
  });
});

describe('loadReferencesCached', () => {
  beforeEach(async () => {
    for (const t of ['faces', 'persons']) await env.DB.prepare(`DELETE FROM ${t}`).run();
    await env.DB.prepare('INSERT INTO persons (id, name, owner_email, created_at) VALUES (?, ?, ?, ?)').bind('p1', 'Anu', 'o@example.com', 't').run();
    clearReferencesCache();
  });

  it('reuses the result within the TTL and refetches after it or a clear', async () => {
    await addConfirmed('p1', 0, '2026-01-01');
    const t0 = 1_000_000;
    expect((await loadReferencesCached(env.DB, 'o@example.com', t0))[0].vectors).toHaveLength(1);
    await addConfirmed('p1', 1, '2026-01-02');
    expect((await loadReferencesCached(env.DB, 'o@example.com', t0 + REFERENCES_CACHE_TTL_MS - 1))[0].vectors).toHaveLength(1);
    expect((await loadReferencesCached(env.DB, 'o@example.com', t0 + REFERENCES_CACHE_TTL_MS))[0].vectors).toHaveLength(2);
    await addConfirmed('p1', 2, '2026-01-03');
    clearReferencesCache();
    expect((await loadReferencesCached(env.DB, 'o@example.com', t0 + REFERENCES_CACHE_TTL_MS + 1))[0].vectors).toHaveLength(3);
  });
});

describe('per-owner references', () => {
  beforeEach(async () => {
    for (const t of ['faces', 'persons']) await env.DB.prepare(`DELETE FROM ${t}`).run();
    await env.DB.prepare("INSERT INTO persons (id, name, owner_email, created_at) VALUES ('a1', 'Anu', 'a@example.com', 't'), ('b1', 'Anu', 'b@example.com', 't')").run();
    await addConfirmed('a1', 0, '2026-01-01');
    await addConfirmed('b1', 1, '2026-01-01');
    await addConfirmed('b1', 2, '2026-01-02');
    clearReferencesCache();
  });

  it('loads only the given owner\'s people', async () => {
    expect((await loadReferences(env.DB, { owner: 'a@example.com' })).map((r) => [r.personId, r.vectors.length])).toEqual([['a1', 1]]);
    expect((await loadReferences(env.DB, { owner: 'b@example.com' })).map((r) => [r.personId, r.vectors.length])).toEqual([['b1', 2]]);
    expect(await loadReferences(env.DB, { owner: 'nobody@example.com' })).toEqual([]);
  });

  it('caches each owner separately', async () => {
    expect((await loadReferencesCached(env.DB, 'a@example.com', 1))[0].personId).toBe('a1');
    expect((await loadReferencesCached(env.DB, 'b@example.com', 2))[0].personId).toBe('b1');
    expect((await loadReferencesCached(env.DB, 'a@example.com', 3))[0].personId).toBe('a1');
  });
});
