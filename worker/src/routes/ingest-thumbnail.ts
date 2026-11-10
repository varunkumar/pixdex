import type { Context } from 'hono';
import type { Env } from '../types';
import { userOf } from '../access';
import { photoAccess } from '../db/visibility';

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
  // The default owner is served straight from R2 with no D1 query (the hot path). Everyone else needs a
  // visible photo: one UNIQUE(content_hash) search plus one albums primary-key search (photoAccess).
  const user = userOf(c);
  if (!user.isDefaultOwner) {
    const access = photoAccess(user, 'p');
    const visible = await c.env.DB.prepare(`SELECT 1 AS x FROM photos p${access.join} WHERE p.content_hash = ?${access.where}`)
      .bind(contentHash, ...access.params)
      .first();
    if (!visible) {
      return c.text('Not Found', 404);
    }
  }
  const object = await c.env.THUMBNAILS.get(keyFor(contentHash));
  if (!object) {
    return c.text('Not Found', 404);
  }
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'image/jpeg',
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
}
