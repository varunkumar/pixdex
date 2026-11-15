import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs helper without type declarations
import { parseWranglerRows, planSeed } from '../scripts/seed-access-lib.mjs';

const NOW = '2026-11-15T10:00:00.000Z';
const ADMIN = 'admin@example.com';

describe('planSeed', () => {
  it('collects two addresses, lowercased and de-duplicated', () => {
    const rows = [
      { owner: 'Admin@Example.com', shared: JSON.stringify(['Friend@Example.com', 'friend@example.com']) },
      { owner: 'admin@example.com', shared: null },
    ];
    expect(planSeed(rows, ADMIN, NOW).emails).toEqual(['admin@example.com', 'friend@example.com']);
  });

  it('includes the admin when the data does not mention them', () => {
    const rows = [{ owner: 'friend@example.com', shared: null }];
    expect(planSeed(rows, 'Admin@Example.com', NOW).emails).toEqual(['admin@example.com', 'friend@example.com']);
  });

  it('skips NULL owner and NULL shared rows', () => {
    const rows = [
      { owner: null, shared: null },
      { owner: 'friend@example.com', shared: null },
      { owner: null, shared: JSON.stringify([]) },
    ];
    expect(planSeed(rows, ADMIN, NOW).emails).toEqual(['admin@example.com', 'friend@example.com']);
  });

  it('throws naming a third address', () => {
    const rows = [{ owner: ADMIN, shared: JSON.stringify(['a@example.com', 'third@example.com']) }];
    expect(() => planSeed(rows, ADMIN, NOW)).toThrow(/third@example\.com/);
  });

  it('throws when there is only one address', () => {
    expect(() => planSeed([{ owner: ADMIN, shared: null }], ADMIN, NOW)).toThrow(/admin@example\.com/);
  });

  it('throws on malformed shared JSON or a non-array', () => {
    expect(() => planSeed([{ owner: ADMIN, shared: '{nope' }], ADMIN, NOW)).toThrow(/shared_with/);
    expect(() => planSeed([{ owner: ADMIN, shared: '{"a":1}' }], ADMIN, NOW)).toThrow(/shared_with/);
    expect(() => planSeed([{ owner: ADMIN, shared: '[1]' }], ADMIN, NOW)).toThrow();
  });

  it('rejects hostile values so they never reach SQL', () => {
    for (const bad of ["a'b@example.com", 'a@b.co; DROP TABLE albums', 'a b@example.com']) {
      expect(() => planSeed([{ owner: bad, shared: null }], ADMIN, NOW)).toThrow();
      expect(() => planSeed([{ owner: ADMIN, shared: JSON.stringify([bad]) }], ADMIN, NOW)).toThrow();
    }
  });

  it('builds exactly the expected SQL', () => {
    const rows = [{ owner: ADMIN, shared: JSON.stringify(['friend@example.com']) }];
    expect(planSeed(rows, ADMIN, NOW).sql).toBe(
      "INSERT INTO access_requests (email, status, created_at, decided_at) VALUES ('admin@example.com', 'approved', '2026-11-15T10:00:00.000Z', '2026-11-15T10:00:00.000Z'), ('friend@example.com', 'approved', '2026-11-15T10:00:00.000Z', '2026-11-15T10:00:00.000Z') ON CONFLICT(email) DO UPDATE SET status = 'approved', decided_at = excluded.decided_at WHERE access_requests.status = 'pending';"
    );
  });

  it('inserts two approved rows and a second run inserts none', async () => {
    await env.DB.prepare('DELETE FROM access_requests').run();
    const { sql } = planSeed([{ owner: ADMIN, shared: JSON.stringify(['friend@example.com']) }], ADMIN, NOW);
    await env.DB.prepare(sql).run();
    await env.DB.prepare(sql).run();
    const rows = await env.DB.prepare('SELECT email, status, created_at, decided_at FROM access_requests ORDER BY email').all();
    expect(rows.results).toEqual([
      { email: 'admin@example.com', status: 'approved', created_at: NOW, decided_at: NOW },
      { email: 'friend@example.com', status: 'approved', created_at: NOW, decided_at: NOW },
    ]);
  });
});

describe('planSeed SQL against existing rows', () => {
  const EARLIER = '2026-11-14T09:00:00.000Z';
  const DECIDED = '2026-11-14T09:30:00.000Z';
  const seedSql = () => planSeed([{ owner: ADMIN, shared: JSON.stringify(['friend@example.com']) }], ADMIN, NOW).sql;
  const all = async () =>
    (await env.DB.prepare('SELECT email, note, status, created_at, decided_at FROM access_requests ORDER BY email').all()).results;
  async function existing(email: string, status: string, decidedAt: string | null) {
    await env.DB.prepare('INSERT INTO access_requests (email, note, status, created_at, decided_at) VALUES (?, ?, ?, ?, ?)')
      .bind(email, 'from the enroll page', status, EARLIER, decidedAt)
      .run();
  }

  it('upgrades a pending row (enrolled before the seed ran) to approved with the seed decided_at', async () => {
    await env.DB.prepare('DELETE FROM access_requests').run();
    await existing('friend@example.com', 'pending', null);
    await env.DB.prepare(seedSql()).run();
    expect(await all()).toEqual([
      { email: 'admin@example.com', note: null, status: 'approved', created_at: NOW, decided_at: NOW },
      { email: 'friend@example.com', note: 'from the enroll page', status: 'approved', created_at: EARLIER, decided_at: NOW },
    ]);
  });

  it.each(['approved', 'denied', 'revoked'])('leaves an existing %s row untouched', async (status) => {
    await env.DB.prepare('DELETE FROM access_requests').run();
    await existing('friend@example.com', status, DECIDED);
    await env.DB.prepare(seedSql()).run();
    expect(await all()).toEqual([
      { email: 'admin@example.com', note: null, status: 'approved', created_at: NOW, decided_at: NOW },
      { email: 'friend@example.com', note: 'from the enroll page', status, created_at: EARLIER, decided_at: DECIDED },
    ]);
  });

  it('a second run (even with a later timestamp) changes nothing', async () => {
    await env.DB.prepare('DELETE FROM access_requests').run();
    await existing('friend@example.com', 'pending', null);
    await env.DB.prepare(seedSql()).run();
    const after = await all();
    const later = planSeed([{ owner: ADMIN, shared: JSON.stringify(['friend@example.com']) }], ADMIN, '2026-11-16T10:00:00.000Z').sql;
    const res = await env.DB.prepare(later).run();
    expect(res.meta.changes).toBe(0);
    expect(await all()).toEqual(after);
  });
});

describe('parseWranglerRows', () => {
  it('reads the results array of the first result object', () => {
    const out = JSON.stringify([{ results: [{ owner: 'a@example.com', shared: null }], success: true }]);
    expect(parseWranglerRows(out)).toEqual([{ owner: 'a@example.com', shared: null }]);
  });
  it('fails clearly on an unexpected shape', () => {
    for (const bad of ['not json', '{}', '[]', '[{"success":true}]']) {
      expect(() => parseWranglerRows(bad)).toThrow(/wrangler/);
    }
  });
});
