import type { Context } from 'hono';
import type { Env } from '../types';

const CONTENT_HASH_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024; // 2MB

function keyFor(contentHash: string): string {
  return `${contentHash}.jpg`;
}

export async function putThumbnailRoute(c: Context<{ Bindings: Env }>) {
  const contentHash = c.req.param('contentHash');
  if (!contentHash || !CONTENT_HASH_PATTERN.test(contentHash)) {
    return c.text('Bad Request', 400);
  }

  const contentLength = c.req.header('content-length');
  if (contentLength && Number(contentLength) > MAX_THUMBNAIL_BYTES) {
    return c.text('Payload Too Large', 413);
  }

  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength > MAX_THUMBNAIL_BYTES) {
    return c.text('Payload Too Large', 413);
  }

  await c.env.THUMBNAILS.put(keyFor(contentHash), bytes, {
    httpMetadata: { contentType: 'image/jpeg' },
  });
  return c.text('created', 201);
}

export async function getThumbnailRoute(c: Context<{ Bindings: Env }>) {
  const contentHash = c.req.param('contentHash');
  if (!contentHash) {
    return c.text('Bad Request', 400);
  }
  const object = await c.env.THUMBNAILS.get(keyFor(contentHash));
  if (!object) {
    return c.text('Not Found', 404);
  }
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
