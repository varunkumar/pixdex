import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('GET /health', () => {
  it('returns 200 ok', async () => {
    const response = await SELF.fetch('https://example.com/health');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });
});
