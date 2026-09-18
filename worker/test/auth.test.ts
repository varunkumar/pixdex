import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('ingest auth', () => {
  it('rejects requests with no token', async () => {
    const response = await SELF.fetch('https://example.com/ingest/check-hashes', {
      method: 'POST',
      body: JSON.stringify({ hashes: [] }),
    });
    expect(response.status).toBe(401);
  });

  it('rejects requests with the wrong token', async () => {
    const response = await SELF.fetch('https://example.com/ingest/check-hashes', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token' },
      body: JSON.stringify({ hashes: [] }),
    });
    expect(response.status).toBe(401);
  });
});
