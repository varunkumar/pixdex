import type { Context } from 'hono';
import type { Env } from '../types';

function keyFor(contentHash: string): string {
  return `${contentHash}.jpg`;
}

export async function putThumbnailRoute(c: Context<{ Bindings: Env }>) {
  const contentHash = c.req.param('contentHash');
  const bytes = await c.req.arrayBuffer();
  await c.env.THUMBNAILS.put(keyFor(contentHash), bytes, {
    httpMetadata: { contentType: 'image/jpeg' },
  });
  return c.text('created', 201);
}

export async function getThumbnailRoute(c: Context<{ Bindings: Env }>) {
  const contentHash = c.req.param('contentHash');
  const object = await c.env.THUMBNAILS.get(keyFor(contentHash));
  if (!object) {
    return c.text('Not Found', 404);
  }
  return new Response(object.body, {
    headers: { 'Content-Type': object.httpMetadata?.contentType ?? 'image/jpeg' },
  });
}
