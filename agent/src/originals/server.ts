import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import mime from 'mime-types';
import { fetchIndexedPhoto } from './lookupPhoto';
import { google } from 'googleapis';
import type { Readable } from 'node:stream';
import { getAuthorizedClient } from '../google/auth';
import { openDriveFileStream, type DriveFilesClient } from '../google/driveFiles';
import type { AgentConfig } from '../config';

export interface OriginalsServerDeps {
  fetchIndexedPhoto: typeof fetchIndexedPhoto;
  /** Opens a Drive file for streaming. Defaults to the agent's stored Google OAuth token. */
  openDriveFile: (
    config: AgentConfig,
    fileId: string
  ) => Promise<{ stream: Readable; contentType: string | null; contentLength: number | null }>;
}

let driveClient: Promise<DriveFilesClient> | null = null;

async function defaultOpenDriveFile(config: AgentConfig, fileId: string) {
  driveClient ??= getAuthorizedClient(config).then(
    (auth) => google.drive({ version: 'v3', auth }).files as unknown as DriveFilesClient
  );
  try {
    return await openDriveFileStream(await driveClient, fileId);
  } catch (error) {
    driveClient = null; // let the next request retry auth
    throw error;
  }
}

const defaultDeps: OriginalsServerDeps = { fetchIndexedPhoto, openDriveFile: defaultOpenDriveFile };

const PATH_PATTERN = /^\/originals\/([^/]+)$/;

export function createOriginalsServer(
  config: AgentConfig,
  deps: Partial<OriginalsServerDeps> = {}
): Server {
  const { fetchIndexedPhoto: lookup, openDriveFile } = { ...defaultDeps, ...deps };

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = url.pathname.match(PATH_PATTERN);

    if (!match) {
      res.writeHead(404).end('Not Found');
      return;
    }

    if (!config.ORIGINALS_TOKEN || req.headers.authorization !== `Bearer ${config.ORIGINALS_TOKEN}`) {
      res.writeHead(401).end('Unauthorized');
      return;
    }

    const photoId = match[1];

    try {
      const photo = await lookup(
        config.CLOUDFLARE_API_BASE_URL,
        photoId,
        config.READ_TOKEN ?? '',
        undefined,
        config.OWNER_EMAIL
      );
      if (photo?.source === 'google_drive' && photo.driveFileId) {
        const file = await openDriveFile(config, photo.driveFileId);
        const headers: Record<string, string | number> = {
          'Content-Type': file.contentType ?? (mime.lookup(photoId) || 'application/octet-stream'),
        };
        if (file.contentLength) headers['Content-Length'] = file.contentLength;
        res.writeHead(200, headers);
        file.stream.on('error', () => res.destroy());
        file.stream.pipe(res);
        return;
      }
      if (!photo || photo.source !== 'local' || !photo.path) {
        res.writeHead(404).end('Not Found');
        return;
      }

      await access(photo.path);
      const stats = await stat(photo.path);
      const contentType = mime.lookup(photo.path) || 'application/octet-stream';

      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stats.size });
      const stream = createReadStream(photo.path);
      stream.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(404).end('Not Found');
        } else {
          res.destroy();
        }
      });
      stream.pipe(res);
    } catch {
      res.writeHead(404).end('Not Found');
    }
  });
}
