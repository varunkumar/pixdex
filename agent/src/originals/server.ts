import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import mime from 'mime-types';
import { fetchIndexedPhoto } from './lookupPhoto';
import type { AgentConfig } from '../config';

export interface OriginalsServerDeps {
  fetchIndexedPhoto: typeof fetchIndexedPhoto;
}

const defaultDeps: OriginalsServerDeps = { fetchIndexedPhoto };

const PATH_PATTERN = /^\/originals\/([^/]+)$/;

export function createOriginalsServer(
  config: AgentConfig,
  deps: Partial<OriginalsServerDeps> = {}
): Server {
  const { fetchIndexedPhoto: lookup } = { ...defaultDeps, ...deps };

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = url.pathname.match(PATH_PATTERN);

    if (!match) {
      res.writeHead(404).end('Not Found');
      return;
    }

    if (!config.ORIGINALS_TOKEN || url.searchParams.get('token') !== config.ORIGINALS_TOKEN) {
      res.writeHead(401).end('Unauthorized');
      return;
    }

    const photoId = match[1];

    try {
      const photo = await lookup(config.CLOUDFLARE_API_BASE_URL, photoId, config.READ_TOKEN ?? '');
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
