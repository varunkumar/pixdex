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
    listeners: Record<string, ((...args: any[]) => void)[]> = {};
    on = vi.fn((event: string, handler: (...args: any[]) => void) => {
      (this.listeners[event] ??= []).push(handler);
      return this;
    });
    emit(event: string, ...args: any[]) {
      for (const handler of this.listeners[event] ?? []) handler(...args);
    }
    constructor() {
      oauth2Instances.push(this);
    }
  }
  return { google: { auth: { OAuth2: FakeOAuth2Client } } };
});

const { getAuthorizedClient, TOKEN_PATH } = await import('../src/google/auth');
const path = await import('node:path');

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

  it('requests consent prompt so a refresh token is always issued', async () => {
    const readTokenFile = vi.fn().mockResolvedValue(null);
    const writeTokenFile = vi.fn().mockResolvedValue(undefined);
    const openBrowser = vi.fn();
    const waitForAuthorizationCode = vi.fn().mockResolvedValue('authorization-code');

    await getAuthorizedClient(config as any, {
      readTokenFile,
      writeTokenFile,
      openBrowser,
      waitForAuthorizationCode,
    });

    const client = oauth2Instances[0];
    expect(client.generateAuthUrl).toHaveBeenCalledWith(
      expect.objectContaining({ access_type: 'offline', prompt: 'consent' })
    );
  });

  it('resolves TOKEN_PATH to agent/.google-token.json regardless of process.cwd()', () => {
    expect(TOKEN_PATH).toBe(path.resolve(__dirname, '../.google-token.json'));
    expect(TOKEN_PATH.endsWith(`${path.sep}agent${path.sep}.google-token.json`)).toBe(true);
  });

  it('persists silently-refreshed tokens back to disk, merging with the stored token', async () => {
    const readTokenFile = vi
      .fn()
      .mockResolvedValueOnce({ access_token: 'stored-access', refresh_token: 'stored-refresh' })
      .mockResolvedValueOnce({ access_token: 'stored-access', refresh_token: 'stored-refresh' });
    const writeTokenFile = vi.fn().mockResolvedValue(undefined);
    const openBrowser = vi.fn();
    const waitForAuthorizationCode = vi.fn();

    await getAuthorizedClient(config as any, {
      readTokenFile,
      writeTokenFile,
      openBrowser,
      waitForAuthorizationCode,
    });

    const client = oauth2Instances[0];
    // Simulate googleapis silently refreshing the access token in the background.
    client.emit('tokens', { access_token: 'refreshed-access' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(writeTokenFile).toHaveBeenCalledWith({
      access_token: 'refreshed-access',
      refresh_token: 'stored-refresh',
    });
  });

  it('registers an error listener on the loopback server so EADDRINUSE rejects instead of hanging', async () => {
    // Exercise the default (non-injected) waitForAuthorizationCode implementation
    // by triggering the real browser flow, then simulate a server bind error.
    const authModule = await import('../src/google/auth');
    const httpModule = await import('node:http');
    const fakeServer: any = {
      handlers: {} as Record<string, (...args: any[]) => void>,
      on(event: string, handler: (...args: any[]) => void) {
        this.handlers[event] = handler;
        return this;
      },
      listen: vi.fn(),
      close: vi.fn(),
    };
    const createServerSpy = vi.spyOn(httpModule.default, 'createServer').mockReturnValue(fakeServer);

    const readTokenFile = vi.fn().mockResolvedValue(null);
    const writeTokenFile = vi.fn();
    const openBrowser = vi.fn();

    const resultPromise = authModule.getAuthorizedClient(config as any, {
      readTokenFile,
      writeTokenFile,
      openBrowser,
    });

    // Give the default waitForAuthorizationCode a tick to register handlers.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(typeof fakeServer.handlers.error).toBe('function');
    fakeServer.handlers.error(new Error('listen EADDRINUSE'));

    await expect(resultPromise).rejects.toThrow(/EADDRINUSE/);

    createServerSpy.mockRestore();
  });
});
