import { createExecutionContext, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';
import { describe, expect, it } from 'vitest';
import { OWNER_TEST_EMAIL, readHeaders } from './helpers';

const me = (headers: Record<string, string>) => SELF.fetch('https://example.com/me', { headers });

describe('viewer identity', () => {
  it('reports the owner as default owner', async () => {
    const response = await me(readHeaders());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: OWNER_TEST_EMAIL, isDefaultOwner: true });
  });

  it('normalizes the email and reports non-owners', async () => {
    const response = await me(readHeaders('Viewer@Example.COM '));
    expect(await response.json()).toEqual({ email: 'viewer@example.com', isDefaultOwner: false });
  });

  it('fails closed with 401 when the Worker has no OWNER_EMAIL', async () => {
    const ctx = createExecutionContext();
    const request = new Request('https://example.com/me', { headers: readHeaders() });
    const response = await worker.fetch(request, { ...env, OWNER_EMAIL: '' }, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(401);
    const search = await worker.fetch(new Request('https://example.com/search', { headers: readHeaders() }), { ...env, OWNER_EMAIL: undefined }, ctx);
    expect(search.status).toBe(401);
  });

  it('rejects a missing identity header', async () => {
    const response = await me({ Authorization: `Bearer ${env.READ_TOKEN}` });
    expect(response.status).toBe(401);
  });

  it('rejects a blank identity header', async () => {
    const response = await me({ Authorization: `Bearer ${env.READ_TOKEN}`, 'X-Viewer-Email': '   ' });
    expect(response.status).toBe(401);
  });

  it('rejects a missing read token', async () => {
    const response = await me({ 'X-Viewer-Email': OWNER_TEST_EMAIL });
    expect(response.status).toBe(401);
  });

  it('keeps /health open', async () => {
    const response = await SELF.fetch('https://example.com/health');
    expect(response.status).toBe(200);
  });
});
