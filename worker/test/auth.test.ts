import { env, SELF } from 'cloudflare:test';
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

describe('read auth', () => {
  it('rejects /search with no token', async () => {
    const response = await SELF.fetch('https://example.com/search');
    expect(response.status).toBe(401);
  });

  it('rejects /albums with the wrong token', async () => {
    const response = await SELF.fetch('https://example.com/albums', {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(response.status).toBe(401);
  });

  it('rejects /daily-pick with no token', async () => {
    const response = await SELF.fetch('https://example.com/daily-pick');
    expect(response.status).toBe(401);
  });

  it('rejects /photos/:id with no token', async () => {
    const response = await SELF.fetch('https://example.com/photos/some-id');
    expect(response.status).toBe(401);
  });

  it('rejects /thumbnails/:contentHash with no token', async () => {
    const response = await SELF.fetch('https://example.com/thumbnails/some-hash');
    expect(response.status).toBe(401);
  });

  it('accepts /thumbnails/:contentHash with the token as a query param, since <img> tags cannot set headers', async () => {
    const response = await SELF.fetch(`https://example.com/thumbnails/does-not-exist?token=${env.READ_TOKEN}`);
    // 404 (not 401) proves the token was accepted and the request reached the route handler.
    expect(response.status).toBe(404);
  });

  it('accepts /search with a valid Authorization header', async () => {
    const response = await SELF.fetch('https://example.com/search', {
      headers: { Authorization: `Bearer ${env.READ_TOKEN}` },
    });
    expect(response.status).toBe(200);
  });
});
