import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { AgentConfig } from '../config';
import { getAuthorizedClient as defaultGetAuthorizedClient } from '../google/auth';
import { openDriveFileStream, type DriveFilesClient } from '../google/driveFiles';
import { DEFAULT_STAGING_MAX_BYTES, stagingLimitBytes } from '../google/staging';

export interface DriveReaderDeps {
  getAuthorizedClient?: typeof defaultGetAuthorizedClient;
  buildDriveClient?: (auth: OAuth2Client) => DriveFilesClient;
  /** Called when there is no stored Google login (a backfill never starts a sign-in). */
  onNoLogin?: () => void;
}

/**
 * Reads a Google Drive file into memory with the agent's stored Google login (a file larger than
 * DRIVE_STAGING_MAX_MB is refused, from its advertised size and again while streaming). Resolves to
 * undefined when there is no usable login, so Drive photos are skipped; it never opens a browser:
 * sign in once with `index-drive`.
 */
export async function createDriveReader(
  config: AgentConfig,
  deps: DriveReaderDeps = {}
): Promise<((fileId: string) => Promise<Buffer>) | undefined> {
  const {
    getAuthorizedClient = defaultGetAuthorizedClient,
    buildDriveClient = (auth) => google.drive({ version: 'v3', auth }).files as unknown as DriveFilesClient,
    onNoLogin,
  } = deps;

  let client: DriveFilesClient;
  try {
    const auth = await getAuthorizedClient(config, {
      openBrowser: () => {},
      waitForAuthorizationCode: async () => {
        onNoLogin?.();
        throw new Error('no stored Google login (run index-drive once to sign in)');
      },
    });
    client = buildDriveClient(auth as OAuth2Client);
  } catch {
    return undefined;
  }

  const limit = config.DRIVE_STAGING_MAX_MB ? stagingLimitBytes(config.DRIVE_STAGING_MAX_MB) : DEFAULT_STAGING_MAX_BYTES;
  return async (fileId: string) => {
    const { stream, contentLength } = await openDriveFileStream(client, fileId);
    if (contentLength !== null && contentLength > limit) {
      stream.destroy();
      throw new Error(`file is larger than DRIVE_STAGING_MAX_MB (${Math.round(contentLength / 1024 / 1024)} MB)`);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > limit) {
        stream.destroy();
        throw new Error('file is larger than DRIVE_STAGING_MAX_MB');
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  };
}
