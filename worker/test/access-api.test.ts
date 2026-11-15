import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AccessApiError,
  accessApiConfig,
  addGroupEmail,
  removeGroupEmail,
  revokeUserSessions,
} from '../src/cf/accessApi';

const cfg = { token: 'tok', accountId: 'acc', groupId: 'grp' };
const GROUP_URL = 'https://api.cloudflare.com/client/v4/accounts/acc/access/groups/grp';

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
let calls: Call[];
let responses: Array<{ status: number; body: unknown }>;

function group(include: unknown[], extra: Record<string, unknown> = {}) {
  return {
    success: true,
    result: {
      id: 'grp',
      name: 'pixdex',
      is_default: false,
      include,
      exclude: [{ email_domain: { domain: 'bad.example' } }],
      require: [{ geo: { country_code: 'IN' } }],
      created_at: 'x',
      updated_at: 'y',
      ...extra,
    },
  };
}

beforeEach(() => {
  calls = [];
  responses = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });
    const r = responses.shift();
    if (!r) throw new Error('unexpected fetch');
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('accessApiConfig', () => {
  it('throws when a value is blank', () => {
    const env = { CF_API_TOKEN: 't', CF_ACCOUNT_ID: ' ', CF_ACCESS_GROUP_ID: 'g' } as never;
    expect(() => accessApiConfig(env)).toThrow(Error);
    expect(accessApiConfig({ CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'a', CF_ACCESS_GROUP_ID: 'g' } as never)).toEqual({
      token: 't',
      accountId: 'a',
      groupId: 'g',
    });
  });
});

describe('addGroupEmail', () => {
  it('adds an email and preserves everything else', async () => {
    const existing = [{ everyone: {} }, { email: { email: 'a@x.com' } }];
    responses.push({ status: 200, body: group(existing) }, { status: 200, body: { success: true } });
    await addGroupEmail(cfg, 'New@X.com');
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    expect(calls[1].url).toBe(GROUP_URL);
    for (const c of calls) expect(c.headers.Authorization).toBe('Bearer tok');
    const body = calls[1].body as Record<string, unknown>;
    expect(body.include).toEqual([...existing, { email: { email: 'new@x.com' } }]);
    expect(body.exclude).toEqual([{ email_domain: { domain: 'bad.example' } }]);
    expect(body.require).toEqual([{ geo: { country_code: 'IN' } }]);
    expect(body.name).toBe('pixdex');
    expect(body.is_default).toBe(false);
  });

  it('does not PUT when already present (case-insensitive)', async () => {
    responses.push({ status: 200, body: group([{ email: { email: 'A@x.com' } }]) });
    await addGroupEmail(cfg, 'a@X.com');
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('retries once on conflict then succeeds', async () => {
    responses.push(
      { status: 200, body: group([]) },
      { status: 409, body: { success: false } },
      { status: 200, body: group([]) },
      { status: 200, body: { success: true } }
    );
    await addGroupEmail(cfg, 'a@x.com');
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT', 'GET', 'PUT']);
  });

  it('throws AccessApiError after a second conflict', async () => {
    responses.push(
      { status: 200, body: group([]) },
      { status: 409, body: { success: false } },
      { status: 200, body: group([]) },
      { status: 409, body: { success: false } }
    );
    await expect(addGroupEmail(cfg, 'a@x.com')).rejects.toMatchObject({ name: 'AccessApiError', status: 409 });
  });

  it('throws AccessApiError with the status on a failed GET', async () => {
    responses.push({ status: 403, body: { success: false } });
    const err = await addGroupEmail(cfg, 'a@x.com').catch((e) => e);
    expect(err).toBeInstanceOf(AccessApiError);
    expect(err.status).toBe(403);
  });

  it('throws on success false with a 200', async () => {
    responses.push({ status: 200, body: { success: false, errors: [] } });
    await expect(addGroupEmail(cfg, 'a@x.com')).rejects.toBeInstanceOf(AccessApiError);
  });
});

describe('removeGroupEmail', () => {
  it('removes only that email entry', async () => {
    const keep = [{ everyone: {} }, { email: { email: 'b@x.com' } }];
    responses.push(
      { status: 200, body: group([...keep, { email: { email: 'A@x.com' } }]) },
      { status: 200, body: { success: true } }
    );
    await removeGroupEmail(cfg, 'a@x.com');
    expect((calls[1].body as { include: unknown[] }).include).toEqual(keep);
    expect((calls[1].body as { exclude: unknown[] }).exclude).toEqual([{ email_domain: { domain: 'bad.example' } }]);
  });

  it('is a no-op when absent', async () => {
    responses.push({ status: 200, body: group([{ email: { email: 'b@x.com' } }]) });
    await removeGroupEmail(cfg, 'a@x.com');
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });
});

describe('revokeUserSessions', () => {
  it('POSTs the email', async () => {
    responses.push({ status: 200, body: { success: true } });
    await revokeUserSessions(cfg, 'A@x.com');
    expect(calls[0].url).toBe('https://api.cloudflare.com/client/v4/accounts/acc/access/organizations/revoke_user');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ email: 'a@x.com' });
    expect(calls[0].headers.Authorization).toBe('Bearer tok');
  });

  it('throws on failure', async () => {
    responses.push({ status: 500, body: { success: false } });
    await expect(revokeUserSessions(cfg, 'a@x.com')).rejects.toBeInstanceOf(AccessApiError);
  });
});
