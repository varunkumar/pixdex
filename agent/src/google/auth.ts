import { exec } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';
import type { AgentConfig } from '../config';

// Resolve relative to this module's own location (agent/src/google/auth.ts),
// not process.cwd(), so the token always lands at agent/.google-token.json
// (which agent/.gitignore covers) regardless of where the CLI is launched from.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const TOKEN_PATH = path.resolve(MODULE_DIR, '../../.google-token.json');
const REDIRECT_PORT = 53682;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const AUTH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface StoredToken {
  access_token?: string | null;
  refresh_token?: string | null;
  [key: string]: unknown;
}

export interface OAuthFlowDeps {
  openBrowser: (url: string) => void;
  waitForAuthorizationCode: (redirectUri: string) => Promise<string>;
  readTokenFile: () => Promise<StoredToken | null>;
  writeTokenFile: (token: StoredToken) => Promise<void>;
}

const defaultDeps: OAuthFlowDeps = {
  openBrowser(url) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${opener} "${url}"`);
  },
  waitForAuthorizationCode(redirectUri) {
    const port = Number(new URL(redirectUri).port);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const settle = (fn: () => void) => {
        clearTimeout(timer);
        fn();
      };
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '', redirectUri);
        const code = url.searchParams.get('code');
        res.end(code ? 'Authorization complete — you can close this tab.' : 'Missing authorization code.');
        server.close();
        if (code) settle(() => resolve(code));
        else settle(() => reject(new Error('No authorization code received')));
      });
      server.on('error', (err) => {
        settle(() => reject(err));
      });
      timer = setTimeout(() => {
        server.close();
        reject(new Error('Timed out waiting for Google OAuth authorization'));
      }, AUTH_TIMEOUT_MS);
      server.listen(port);
    });
  },
  async readTokenFile() {
    try {
      const raw = await readFile(TOKEN_PATH, 'utf-8');
      return JSON.parse(raw) as StoredToken;
    } catch {
      // A missing file is expected on first run. A corrupted/expired or
      // revoked token will surface as Drive API failures later; if that
      // happens, delete TOKEN_PATH and re-authorize.
      return null;
    }
  },
  async writeTokenFile(token) {
    await writeFile(TOKEN_PATH, JSON.stringify(token, null, 2), { mode: 0o600, encoding: 'utf-8' });
  },
};

export async function getAuthorizedClient(
  config: AgentConfig,
  deps: Partial<OAuthFlowDeps> = {}
) {
  if (!config.GOOGLE_OAUTH_CLIENT_ID || !config.GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new Error(
      'GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set to use Google Drive indexing'
    );
  }

  const { openBrowser, waitForAuthorizationCode, readTokenFile, writeTokenFile } = {
    ...defaultDeps,
    ...deps,
  };

  const client = new google.auth.OAuth2(
    config.GOOGLE_OAUTH_CLIENT_ID,
    config.GOOGLE_OAUTH_CLIENT_SECRET,
    REDIRECT_URI
  );

  // Persist silently-refreshed access tokens back to disk so the stored
  // token doesn't go stale. A refresh doesn't always include a new
  // refresh_token, so merge onto the previously stored fields rather than
  // overwriting them.
  client.on('tokens', (newTokens) => {
    void (async () => {
      const existing = (await readTokenFile()) ?? {};
      await writeTokenFile({ ...existing, ...newTokens } as StoredToken);
    })();
  });

  const stored = await readTokenFile();
  if (stored) {
    client.setCredentials(stored);
    return client;
  }

  const authUrl = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });
  openBrowser(authUrl);
  const code = await waitForAuthorizationCode(REDIRECT_URI);
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  await writeTokenFile(tokens as StoredToken);
  return client;
}
