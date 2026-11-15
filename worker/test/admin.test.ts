import { env, SELF } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { requireAdmin } from '../src/admin';
import { requireProxyToken } from '../src/auth';
import type { Env } from '../src/types';
import { OWNER_TEST_EMAIL, readHeaders } from './helpers';

const me = (headers: Record<string, string>) => SELF.fetch('https://example.com/me', { headers });

const app = new Hono<{ Bindings: Env }>();
app.get('/admin-only', requireAdmin, (c) => c.text('ok'));
app.get('/proxy-only', requireProxyToken, (c) => c.text('ok'));

describe('/me admin flag', () => {
  it('is true for the admin in any letter case', async () => {
    for (const email of [OWNER_TEST_EMAIL, 'OWNER@Example.com']) {
      expect(await (await me(readHeaders(email))).json()).toEqual({ email: OWNER_TEST_EMAIL, admin: true });
    }
  });

  it('is false for another user', async () => {
    expect(await (await me(readHeaders('other@example.com'))).json()).toEqual({
      email: 'other@example.com',
      admin: false,
    });
  });
});

describe('requireAdmin', () => {
  it('404s a non-admin and passes the admin', async () => {
    expect((await app.request('/admin-only', { headers: readHeaders('other@example.com') }, env)).status).toBe(404);
    expect((await app.request('/admin-only', {}, env)).status).toBe(404);
    expect((await app.request('/admin-only', { headers: readHeaders() }, env)).status).toBe(200);
  });
});

describe('requireProxyToken', () => {
  it('401s a missing or wrong bearer', async () => {
    expect((await app.request('/proxy-only', {}, env)).status).toBe(401);
    expect((await app.request('/proxy-only', { headers: { Authorization: 'Bearer nope' } }, env)).status).toBe(401);
  });

  it('passes with the right bearer and no viewer header', async () => {
    const res = await app.request('/proxy-only', { headers: { Authorization: `Bearer ${env.READ_TOKEN}` } }, env);
    expect(res.status).toBe(200);
  });
});
