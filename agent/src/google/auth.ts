import { exec } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { google } from 'googleapis';
import type { AgentConfig } from '../config';

const TOKEN_PATH = path.resolve('.google-token.json');
const REDIRECT_PORT = 53682;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

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
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '', redirectUri);
        const code = url.searchParams.get('code');
        res.end(code ? 'Authorization complete — you can close this tab.' : 'Missing authorization code.');
        server.close();
        if (code) resolve(code);
        else reject(new Error('No authorization code received'));
      });
      server.listen(port);
    });
  },
  async readTokenFile() {
    try {
      const raw = await readFile(TOKEN_PATH, 'utf-8');
      return JSON.parse(raw) as StoredToken;
    } catch {
      return null;
    }
  },
  async writeTokenFile(token) {
    await writeFile(TOKEN_PATH, JSON.stringify(token, null, 2), 'utf-8');
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

  const stored = await readTokenFile();
  if (stored) {
    client.setCredentials(stored);
    return client;
  }

  const authUrl = client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
  openBrowser(authUrl);
  const code = await waitForAuthorizationCode(REDIRECT_URI);
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  await writeTokenFile(tokens as StoredToken);
  return client;
}
