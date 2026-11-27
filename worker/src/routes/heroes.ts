import type { Context } from 'hono';
import type { Env } from '../types';
import { userOf } from '../access';
import { photoAccess } from '../db/visibility';

const CONTENT_HASH_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_HERO_BYTES = 2 * 1024 * 1024; // 2MB

function keyFor(contentHash: string): string {
  return `hero/${contentHash}.jpg`;
}

/** The photo's album owner when the caller may see it, else null. One D1 read (content hash, then albums primary key). */
async function visiblePhoto(c: Context<{ Bindings: Env }>, contentHash: string) {
  const access = photoAccess(userOf(c), 'p');
  return c.env.DB.prepare(`SELECT va.owner_email AS owner FROM photos p ${access.join} WHERE p.content_hash = ? ${access.where}`)
    .bind(contentHash, ...access.params)
    .first<{ owner: string | null }>();
}

/** GET /heroes/:contentHash: the stored hero, 404 if the photo is not visible or no hero was made yet. */
export async function getHeroRoute(c: Context<{ Bindings: Env }>) {
  const contentHash = c.req.param('contentHash');
  if (!contentHash || !CONTENT_HASH_PATTERN.test(contentHash)) {
    return c.text('Bad Request', 400);
  }
  if (!(await visiblePhoto(c, contentHash))) {
    return c.text('Not Found', 404);
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

/**
 * PUT /heroes/:contentHash: album owner only (404 not visible, 403 viewer). Written once: the R2 put is
 * conditional, so an existing hero is kept (200) and a new one is 201. No image processing here.
 */
export async function putHeroRoute(c: Context<{ Bindings: Env }>) {
  const contentHash = c.req.param('contentHash');
  if (!contentHash || !CONTENT_HASH_PATTERN.test(contentHash)) {
    return c.text('Bad Request', 400);
  }
  const photo = await visiblePhoto(c, contentHash);
  if (!photo) {
    return c.text('Not Found', 404);
  }
  if (photo.owner !== userOf(c).email) {
    return c.text('Forbidden', 403);
  }

  const contentLength = c.req.header('content-length');
  if (contentLength && Number(contentLength) > MAX_HERO_BYTES) {
    return c.text('Payload Too Large', 413);
  }
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength > MAX_HERO_BYTES) {
    return c.text('Payload Too Large', 413);
  }
  const magic = new Uint8Array(bytes, 0, Math.min(3, bytes.byteLength));
  if (magic[0] !== 0xff || magic[1] !== 0xd8 || magic[2] !== 0xff) {
    return c.text('Bad Request', 400);
  }

  const stored = await c.env.THUMBNAILS.put(keyFor(contentHash), bytes, {
    httpMetadata: { contentType: 'image/jpeg' },
    onlyIf: new Headers({ 'If-None-Match': '*' }),
  });
  return stored === null ? c.text('ok', 200) : c.text('created', 201);
}
