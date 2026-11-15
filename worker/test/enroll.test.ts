import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import app from '../src/index';

const run = (sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params).run();
const rows = async () =>
  (await env.DB.prepare('SELECT email, note, status, created_at, decided_at FROM access_requests ORDER BY email').all()).results;

// The test pool provides a real ratelimit binding (5 per 60 s per key): every call gets its own IP,
// so only the tests that pass a fake limiter exercise refusal.
let ipCounter = 0;
const auth = () => ({
  Authorization: `Bearer ${env.READ_TOKEN}`,
  'Content-Type': 'application/json',
  'X-Client-IP': `198.51.100.${++ipCounter}`,
});
const enroll = (body: unknown, headers: Record<string, string> = auth(), e: object = env) =>
  app.request(
    '/enroll',
    { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) },
    e
  );

beforeEach(async () => {
  await run('DELETE FROM access_requests');
});

describe('POST /enroll', () => {
  it('inserts a pending row and answers 202 {ok:true}', async () => {
    const res = await enroll({ email: 'a@example.com', note: 'hi' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ email: 'a@example.com', note: 'hi', status: 'pending', decided_at: null });
  });

  it('trims and lowercases the email; a repeat leaves one row with an identical response', async () => {
    const a = await enroll({ email: '  Foo@Example.COM ' });
    const b = await enroll({ email: 'foo@example.com' });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(await a.text()).toBe(await b.text());
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ email: 'foo@example.com' });
  });

  it.each(['approved', 'denied', 'revoked'])('leaves a %s row unchanged and answers the same', async (status) => {
    await run(
      `INSERT INTO access_requests (email, note, status, created_at, decided_at) VALUES ('x@example.com', 'old', ?, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
      status
    );
    const before = await rows();
    const res = await enroll({ email: 'x@example.com', note: 'new' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(await rows()).toEqual(before);
  });

  it('answers the same 202 and inserts nothing when 200 are pending', async () => {
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200)
       INSERT INTO access_requests (email, created_at) SELECT 'p' || i || '@example.com', '2026-01-01T00:00:00.000Z' FROM n`
    ).run();
    const res = await enroll({ email: 'late@example.com' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM access_requests').first('n')).toBe(200);
    expect(await env.DB.prepare(`SELECT 1 FROM access_requests WHERE email = 'late@example.com'`).first()).toBeNull();
  });

  it('answers 400 for an invalid body and writes nothing', async () => {
    for (const body of [
      { email: 'not-an-email' },
      { email: 'a@example.com', note: 'n'.repeat(201) },
      { email: `${'a'.repeat(250)}@example.com` },
      'not json',
    ]) {
      expect((await enroll(body)).status).toBe(400);
    }
    expect(await rows()).toEqual([]);
  });

  it('accepts a 200 character note', async () => {
    expect((await enroll({ email: 'a@example.com', note: 'n'.repeat(200) })).status).toBe(202);
  });

  it('answers 401 without the proxy bearer token', async () => {
    expect((await enroll({ email: 'a@example.com' }, { 'Content-Type': 'application/json' })).status).toBe(401);
    expect((await enroll({ email: 'a@example.com' }, { Authorization: 'Bearer wrong' })).status).toBe(401);
    expect(await rows()).toEqual([]);
  });

  it('answers 429 and inserts nothing when the limiter refuses, keyed by X-Client-IP', async () => {
    const keys: string[] = [];
    const limiter = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: false }) };
    const res = await enroll(
      { email: 'a@example.com' },
      { ...auth(), 'X-Client-IP': '203.0.113.9' },
      { ...env, ENROLL_LIMITER: limiter }
    );
    expect(res.status).toBe(429);
    expect(keys).toEqual(['203.0.113.9']);
    expect(await rows()).toEqual([]);
  });

  it('uses the key "unknown" without X-Client-IP and proceeds when the limiter allows', async () => {
    const keys: string[] = [];
    const limiter = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: true }) };
    const noIp = { Authorization: `Bearer ${env.READ_TOKEN}`, 'Content-Type': 'application/json' };
    const res = await enroll({ email: 'a@example.com' }, noIp, { ...env, ENROLL_LIMITER: limiter });
    expect(res.status).toBe(202);
    expect(keys).toEqual(['unknown']);
    expect(await rows()).toHaveLength(1);
  });

  it('the pending count walks idx_access_requests_status_created', async () => {
    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM access_requests WHERE status = 'pending'`
    ).all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join('\n')).toContain('idx_access_requests_status_created');
  });
});
