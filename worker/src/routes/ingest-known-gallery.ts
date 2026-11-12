import type { Context } from 'hono';
import type { Env } from '../types';

export const GALLERY_KEY = 'known/gallery.json';
export const MAX_GALLERY_BYTES = 64 * 1024 * 1024;

/**
 * Agent-only backup of the known-personality gallery as one opaque R2 object. The Worker never parses
 * it (no JSON work, no matching): the bytes are streamed through, so CPU stays flat whatever the size.
 */
export async function putKnownGalleryRoute(c: Context<{ Bindings: Env }>) {
  const header = c.req.header('content-length');
  const length = header === undefined ? undefined : Number(header);
  if (length !== undefined && (!Number.isInteger(length) || length < 0)) return c.text('Bad Request', 400);
  if (length !== undefined && length > MAX_GALLERY_BYTES) return c.text('Payload Too Large', 413);
  if (length === 0 || !c.req.raw.body) return c.text('Bad Request', 400);

  const options = { httpMetadata: { contentType: 'application/json' } };
  if (length !== undefined) {
    // Known length: stream straight to R2 without buffering.
    await c.env.THUMBNAILS.put(GALLERY_KEY, c.req.raw.body, options);
  } else {
    // Chunked upload (no length to bound the stream): buffer, then check the size.
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength === 0) return c.text('Bad Request', 400);
    if (bytes.byteLength > MAX_GALLERY_BYTES) return c.text('Payload Too Large', 413);
    await c.env.THUMBNAILS.put(GALLERY_KEY, bytes, options);
  }
  return c.text('created', 201);
}

/** Existence and size of the backup via one R2 head (no body download, no D1, no parsing). */
export async function knownGalleryStatusRoute(c: Context<{ Bindings: Env }>) {
  const head = await c.env.THUMBNAILS.head(GALLERY_KEY);
  return c.json({ exists: head !== null, size: head ? head.size : null });
}

export async function getKnownGalleryRoute(c: Context<{ Bindings: Env }>) {
  const object = await c.env.THUMBNAILS.get(GALLERY_KEY);
  if (!object) return c.text('Not Found', 404);
  return new Response(object.body, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
