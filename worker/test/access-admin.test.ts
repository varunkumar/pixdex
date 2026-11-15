import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { OWNER_TEST_EMAIL, readHeaders } from './helpers';

// Dummy values from vitest.config.ts miniflare bindings.
const CF_API_TOKEN = 'test-cf-api-token';
const GROUP_URL = 'https://api.cloudflare.com/client/v4/accounts/test-account-id/access/groups/test-access-group-id';
const REVOKE_URL = 'https://api.cloudflare.com/client/v4/accounts/test-account-id/access/organizations/revoke_user';

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let include: Array<Record<string, unknown>>;
// Each predicate that matches a call makes that call fail (once per entry).
let failures: Array<{ match: (c: Call) => boolean; status?: number; network?: boolean }>;

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM access_requests').run();
  calls = [];
  include = [];
  failures = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const call = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body as string) : undefined };
    calls.push(call);
    const i = failures.findIndex((f) => f.match(call));
    if (i >= 0) {
      const [f] = failures.splice(i, 1);
      if (f.network) throw new TypeError('network down');
      return new Response(JSON.stringify({ success: false, errors: [{ message: 'secret detail' }] }), { status: f.status ?? 500 });
    }
    if (url === GROUP_URL && call.method === 'GET') {
      return Response.json({ success: true, result: { id: 'grp', name: 'pixdex', include } });
    }
    if (url === GROUP_URL && call.method === 'PUT') {
      include = (call.body as { include: Array<Record<string, unknown>> }).include;
      return Response.json({ success: true, result: call.body });
    }
    if (url === REVOKE_URL && call.method === 'POST') return Response.json({ success: true, result: null });
    throw new Error(`unexpected fetch ${call.method} ${url}`);
  });
});
afterEach(() => vi.unstubAllGlobals());

const ADMIN = OWNER_TEST_EMAIL;
const NON_ADMIN = 'other@example.com';

const req = (method: string, path: string, email: string | null = ADMIN) =>
  app.request(path, { method, headers: email === null ? {} : readHeaders(email) }, env);

async function insert(email: string, status = 'pending', createdAt = new Date().toISOString(), note: string | null = null) {
  const r = await env.DB.prepare(
    `INSERT INTO access_requests (email, note, status, created_at, decided_at) VALUES (?, ?, ?, ?, ?) RETURNING id`
  )
    .bind(email, note, status, createdAt, status === 'pending' ? null : '2026-01-02T00:00:00.000Z')
    .first<{ id: number }>();
  return r!.id;
}
const rowOf = (id: number) =>
  env.DB.prepare('SELECT email, status, decided_at FROM access_requests WHERE id = ?').bind(id).first<{
    email: string;
    status: string;
    decided_at: string | null;
  }>();
const groupEmails = () => include.map((r) => (r.email as { email: string }).email);

describe('admin gating', () => {
  it('404s a non-admin on all four routes with no Cloudflare call, 401s without a bearer', async () => {
    const id = await insert('a@example.com');
    for (const [m, p] of [
      ['GET', '/admin/requests'],
      ['POST', `/admin/requests/${id}/approve`],
      ['POST', `/admin/requests/${id}/deny`],
      ['POST', `/admin/requests/${id}/revoke`],
    ]) {
      expect((await req(m, p, NON_ADMIN)).status).toBe(404);
      expect((await req(m, p, null)).status).toBe(401);
    }
    expect(calls).toEqual([]);
    expect((await rowOf(id))!.status).toBe('pending');
  });

  it('does not affect /enroll', async () => {
    const res = await app.request(
      '/enroll',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.READ_TOKEN}`, 'Content-Type': 'application/json', 'X-Client-IP': '203.0.113.77' },
        body: JSON.stringify({ email: 'new@example.com' }),
      },
      env
    );
    expect(res.status).toBe(202);
  });
});

describe('GET /admin/requests', () => {
  it('lists newest first with camelCase rows and filters by status', async () => {
    // Inserted in time order, as enroll does (created_at is stamped at insert, so id order is time order).
    const a = await insert('a@example.com', 'pending', '2026-01-01T00:00:00.000Z', 'hello <b>');
    const c = await insert('c@example.com', 'pending', '2026-01-02T00:00:00.000Z');
    const b = await insert('b@example.com', 'approved', '2026-01-03T00:00:00.000Z');
    const res = await req('GET', '/admin/requests');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { requests: Array<{ id: number }>; pendingCount: number; queueFull: boolean };
    expect(body.requests.map((r) => r.id)).toEqual([b, c, a]);
    expect(body.requests[2]).toEqual({
      id: a,
      email: 'a@example.com',
      note: 'hello <b>',
      status: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
      decidedAt: null,
    });
    expect(body.pendingCount).toBe(2);
    expect(body.queueFull).toBe(false);

    const pending = (await (await req('GET', '/admin/requests?status=pending')).json()) as typeof body;
    expect(pending.requests.map((r) => r.id)).toEqual([c, a]);
    expect(pending.pendingCount).toBe(2);
    const approved = (await (await req('GET', '/admin/requests?status=approved')).json()) as typeof body;
    expect(approved.requests.map((r) => r.id)).toEqual([b]);
  });

  it('400s an invalid status', async () => {
    expect((await req('GET', '/admin/requests?status=bogus')).status).toBe(400);
  });

  it('reports queueFull at 200 pending, not at 199, and caps the list at 200', async () => {
    const stmts = Array.from({ length: 199 }, (_, i) =>
      env.DB.prepare(`INSERT INTO access_requests (email, created_at) VALUES (?, ?)`).bind(
        `p${i}@example.com`,
        new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()
      )
    );
    await env.DB.batch(stmts);
    let body = (await (await req('GET', '/admin/requests')).json()) as { requests: unknown[]; pendingCount: number; queueFull: boolean };
    expect(body).toMatchObject({ pendingCount: 199, queueFull: false });
    expect(body.requests).toHaveLength(199);
    await insert('last@example.com');
    await insert('done@example.com', 'denied');
    body = (await (await req('GET', '/admin/requests')).json()) as typeof body;
    expect(body).toMatchObject({ pendingCount: 200, queueFull: true });
    expect(body.requests).toHaveLength(200);
  });
});

describe('POST /admin/requests/:id/approve', () => {
  it.each(['pending', 'denied', 'revoked'])('approves from %s: adds the email and sets decidedAt', async (status) => {
    const id = await insert('a@example.com', status);
    const before = Date.now();
    const res = await req('POST', `/admin/requests/${id}/approve`);
    expect(res.status).toBe(200);
    const { request } = (await res.json()) as { request: { status: string; decidedAt: string; email: string } };
    expect(request).toMatchObject({ id, email: 'a@example.com', status: 'approved' });
    expect(Date.parse(request.decidedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(request.decidedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(groupEmails()).toEqual(['a@example.com']);
    expect(await rowOf(id)).toMatchObject({ status: 'approved', decided_at: request.decidedAt });
  });

  it('409s an approved row with no Cloudflare call', async () => {
    const id = await insert('a@example.com', 'approved');
    expect((await req('POST', `/admin/requests/${id}/approve`)).status).toBe(409);
    expect(calls).toEqual([]);
  });

  it('allows approving the admin email', async () => {
    const id = await insert(ADMIN);
    expect((await req('POST', `/admin/requests/${id}/approve`)).status).toBe(200);
    expect(groupEmails()).toEqual([ADMIN]);
  });

  it('on a Cloudflare failure answers 502, keeps pending, and a retry approves', async () => {
    const id = await insert('a@example.com');
    failures.push({ match: (c) => c.method === 'PUT', status: 500 });
    const res = await req('POST', `/admin/requests/${id}/approve`);
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toHaveProperty('error');
    expect(text).not.toContain(CF_API_TOKEN);
    expect(text).not.toContain('secret detail');
    expect((await rowOf(id))!.status).toBe('pending');

    expect((await req('POST', `/admin/requests/${id}/approve`)).status).toBe(200);
    expect((await rowOf(id))!.status).toBe('approved');
    expect(groupEmails()).toEqual(['a@example.com']);
  });

  it('a network-level failure is also a 502', async () => {
    const id = await insert('a@example.com');
    failures.push({ match: () => true, network: true });
    const res = await req('POST', `/admin/requests/${id}/approve`);
    expect(res.status).toBe(502);
    expect((await rowOf(id))!.status).toBe('pending');
  });

  it('missing Cloudflare config is a 502 and leaves the row', async () => {
    const id = await insert('a@example.com');
    const res = await app.request(`/admin/requests/${id}/approve`, { method: 'POST', headers: readHeaders() }, { ...env, CF_API_TOKEN: '' });
    expect(res.status).toBe(502);
    expect(calls).toEqual([]);
    expect((await rowOf(id))!.status).toBe('pending');
  });
});

describe('POST /admin/requests/:id/deny', () => {
  it('denies a pending row with no Cloudflare call', async () => {
    const id = await insert('a@example.com');
    const res = await req('POST', `/admin/requests/${id}/deny`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { request: { status: string } }).request.status).toBe('denied');
    expect(calls).toEqual([]);
    const row = await rowOf(id);
    expect(row!.status).toBe('denied');
    expect(row!.decided_at).not.toBeNull();
  });

  it.each(['approved', 'denied', 'revoked'])('409s from %s', async (status) => {
    const id = await insert('a@example.com', status);
    expect((await req('POST', `/admin/requests/${id}/deny`)).status).toBe(409);
    expect(calls).toEqual([]);
    expect((await rowOf(id))!.status).toBe(status);
  });

  it('400s the admin email and calls nothing', async () => {
    const id = await insert(ADMIN);
    expect((await req('POST', `/admin/requests/${id}/deny`)).status).toBe(400);
    expect(calls).toEqual([]);
    expect((await rowOf(id))!.status).toBe('pending');
  });
});

describe('POST /admin/requests/:id/revoke', () => {
  it('removes from the group, revokes sessions and sets revoked', async () => {
    include = [{ email: { email: 'keep@example.com' } }, { email: { email: 'a@example.com' } }];
    const id = await insert('a@example.com', 'approved');
    const res = await req('POST', `/admin/requests/${id}/revoke`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { request: { status: string } }).request.status).toBe('revoked');
    expect(groupEmails()).toEqual(['keep@example.com']);
    const revokeCalls = calls.filter((c) => c.url === REVOKE_URL);
    expect(revokeCalls).toEqual([{ url: REVOKE_URL, method: 'POST', body: { email: 'a@example.com' } }]);
    // The group edit happens before the session revoke.
    expect(calls.findIndex((c) => c.method === 'PUT')).toBeLessThan(calls.findIndex((c) => c.url === REVOKE_URL));
    expect((await rowOf(id))!.status).toBe('revoked');
  });

  it.each(['pending', 'denied', 'revoked'])('409s from %s with no Cloudflare call', async (status) => {
    const id = await insert('a@example.com', status);
    expect((await req('POST', `/admin/requests/${id}/revoke`)).status).toBe(409);
    expect(calls).toEqual([]);
  });

  it('400s the admin email and calls nothing', async () => {
    const id = await insert(ADMIN, 'approved');
    expect((await req('POST', `/admin/requests/${id}/revoke`)).status).toBe(400);
    expect(calls).toEqual([]);
    expect((await rowOf(id))!.status).toBe('approved');
  });

  it('a session revoke failure answers 502 and leaves approved', async () => {
    include = [{ email: { email: 'a@example.com' } }];
    const id = await insert('a@example.com', 'approved');
    failures.push({ match: (c) => c.url === REVOKE_URL, status: 500 });
    expect((await req('POST', `/admin/requests/${id}/revoke`)).status).toBe(502);
    expect((await rowOf(id))!.status).toBe('approved');
    // Retry is safe: the group is already clean, the session revoke now succeeds.
    expect((await req('POST', `/admin/requests/${id}/revoke`)).status).toBe(200);
    expect((await rowOf(id))!.status).toBe('revoked');
  });
});

describe('a padded, mixed-case ADMIN_EMAIL', () => {
  const PADDED = { ...env, ADMIN_EMAIL: '  Owner@Example.com ' };

  it.each([
    ['deny', 'pending'],
    ['revoke', 'approved'],
  ])('%s still refuses the admin row with 400 and no Cloudflare call', async (action, status) => {
    const id = await insert(ADMIN, status);
    const res = await app.request(`/admin/requests/${id}/${action}`, { method: 'POST', headers: readHeaders() }, PADDED);
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
    expect((await rowOf(id))!.status).toBe(status);
  });
});

describe('a race lost during the Cloudflare call', () => {
  const SENTINEL = '2020-05-05T05:05:05.000Z';
  it.each([
    // Another tab approved (or revoked) the row first; its decided_at is the sentinel below.
    ['approve', 'pending', 'approved', (c: Call) => c.method === 'PUT'],
    ['revoke', 'approved', 'revoked', (c: Call) => c.url === REVOKE_URL],
  ] as const)('%s answers 409 and keeps the status the other writer set', async (action, from, other, during) => {
    if (action === 'revoke') include = [{ email: { email: 'a@example.com' } }];
    const id = await insert('a@example.com', from);
    const stubbed = fetch as (url: string, init: RequestInit) => Promise<Response>;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const res = await stubbed(url, init);
      // Another writer (a second tab) decides the same row while this request waits on Cloudflare.
      if (during(calls[calls.length - 1])) {
        await env.DB.prepare('UPDATE access_requests SET status = ?, decided_at = ? WHERE id = ?').bind(other, SENTINEL, id).run();
      }
      return res;
    });
    const res = await req('POST', `/admin/requests/${id}/${action}`);
    expect(res.status).toBe(409);
    expect(await rowOf(id)).toMatchObject({ status: other, decided_at: SENTINEL });
  });
});

describe('unknown ids', () => {
  it.each(['approve', 'deny', 'revoke'])('%s 404s an unknown or non-numeric id', async (action) => {
    expect((await req('POST', `/admin/requests/999999/${action}`)).status).toBe(404);
    expect((await req('POST', `/admin/requests/abc/${action}`)).status).toBe(404);
    expect((await req('POST', `/admin/requests/1.5/${action}`)).status).toBe(404);
    expect(calls).toEqual([]);
  });
});

describe('list query plans', () => {
  it('the filtered list and the pending count use idx_access_requests_status_created', async () => {
    const { LIST_BY_STATUS_SQL, PENDING_COUNT_SQL } = await import('../src/routes/access-requests');
    const plan = async (sql: string, ...p: unknown[]) =>
      (await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...p).all<{ detail: string }>()).results.map((r) => r.detail).join('\n');
    const filtered = await plan(LIST_BY_STATUS_SQL, 'pending');
    expect(filtered).toMatch(/SEARCH access_requests USING INDEX idx_access_requests_status_created \(status=\?\)/);
    expect(filtered).not.toMatch(/TEMP B-TREE/);
    expect(await plan(PENDING_COUNT_SQL)).toMatch(/SEARCH access_requests USING COVERING INDEX idx_access_requests_status_created \(status=\?\)/);
  });

  it('the unfiltered list walks the primary key backwards with no sort', async () => {
    const { LIST_ALL_SQL } = await import('../src/routes/access-requests');
    const r = await env.DB.prepare(`EXPLAIN QUERY PLAN ${LIST_ALL_SQL}`).all<{ detail: string }>();
    const plan = r.results.map((x) => x.detail).join('\n');
    expect(plan).toMatch(/SCAN access_requests/);
    expect(plan).not.toMatch(/TEMP B-TREE/);
  });
});
