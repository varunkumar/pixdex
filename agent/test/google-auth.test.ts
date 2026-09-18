import { beforeEach, describe, expect, it, vi } from 'vitest';

const oauth2Instances: any[] = [];

vi.mock('googleapis', () => {
  class FakeOAuth2Client {
    credentials: Record<string, unknown> = {};
    generateAuthUrl = vi.fn().mockReturnValue('https://accounts.google.com/o/oauth2/auth?mock=1');
    getToken = vi.fn().mockResolvedValue({ tokens: { access_token: 'new-access', refresh_token: 'new-refresh' } });
    setCredentials = vi.fn((creds: Record<string, unknown>) => {
      this.credentials = creds;
    });
    constructor() {
      oauth2Instances.push(this);
    }
  }
  return { google: { auth: { OAuth2: FakeOAuth2Client } } };
});

const { getAuthorizedClient } = await import('../src/google/auth');

const config = {
  CLOUDFLARE_API_BASE_URL: 'https://example.workers.dev',
  INGEST_TOKEN: 'secret-token',
  OLLAMA_BASE_URL: 'http://localhost:11434',
  OLLAMA_MODEL: 'qwen3.5:27b-mlx',
  GOOGLE_OAUTH_CLIENT_ID: 'client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
} as const;

describe('getAuthorizedClient', () => {
  beforeEach(() => {
    oauth2Instances.length = 0;
  });

  it('reuses a stored token without running the browser flow', async () => {
    const readTokenFile = vi.fn().mockResolvedValue({ access_token: 'stored-access', refresh_token: 'stored-refresh' });
    const writeTokenFile = vi.fn();
    const openBrowser = vi.fn();
    const waitForAuthorizationCode = vi.fn();

    const client = await getAuthorizedClient(config as any, {
      readTokenFile,
      writeTokenFile,
      openBrowser,
      waitForAuthorizationCode,
    });

    expect(openBrowser).not.toHaveBeenCalled();
    expect(waitForAuthorizationCode).not.toHaveBeenCalled();
    expect(writeTokenFile).not.toHaveBeenCalled();
    expect((client as any).credentials).toEqual({ access_token: 'stored-access', refresh_token: 'stored-refresh' });
  });

  it('runs the browser flow and persists the resulting token when none is stored', async () => {
    const readTokenFile = vi.fn().mockResolvedValue(null);
    const writeTokenFile = vi.fn().mockResolvedValue(undefined);
    const openBrowser = vi.fn();
    const waitForAuthorizationCode = vi.fn().mockResolvedValue('authorization-code');

    const client = await getAuthorizedClient(config as any, {
      readTokenFile,
      writeTokenFile,
      openBrowser,
      waitForAuthorizationCode,
    });

    expect(openBrowser).toHaveBeenCalledWith(expect.stringContaining('accounts.google.com'));
    expect(waitForAuthorizationCode).toHaveBeenCalled();
    expect(writeTokenFile).toHaveBeenCalledWith({ access_token: 'new-access', refresh_token: 'new-refresh' });
    expect((client as any).credentials).toEqual({ access_token: 'new-access', refresh_token: 'new-refresh' });
  });

  it('throws a clear error when OAuth credentials are not configured', async () => {
    await expect(
      getAuthorizedClient({ ...config, GOOGLE_OAUTH_CLIENT_ID: undefined } as any)
    ).rejects.toThrow(/GOOGLE_OAUTH_CLIENT_ID/);
  });
});
