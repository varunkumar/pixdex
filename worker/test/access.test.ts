import { createExecutionContext, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';
import { describe, expect, it } from 'vitest';
import { OWNER_TEST_EMAIL, readHeaders } from './helpers';

const me = (headers: Record<string, string>) => SELF.fetch('https://example.com/me', { headers });

describe('viewer identity', () => {
  it('reports the resolved email only', async () => {
    const response = await me(readHeaders());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: OWNER_TEST_EMAIL });
  });

  it('normalizes the email', async () => {
    const response = await me(readHeaders('Viewer@Example.COM '));
    expect(await response.json()).toEqual({ email: 'viewer@example.com' });
  });

  it('needs no owner address configured: any forwarded identity resolves', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request('https://example.com/me', { headers: readHeaders() }), { ...env }, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
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
