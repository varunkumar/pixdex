import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const URL_ = 'https://example.com/ingest/known-gallery';
const auth = (token: string = env.INGEST_TOKEN) => ({ Authorization: `Bearer ${token}` });
const put = (body: BodyInit | null, headers: Record<string, string> = auth()) =>
  SELF.fetch(URL_, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body });
const get = (headers: Record<string, string> = auth()) => SELF.fetch(URL_, { headers });

describe('/ingest/known-gallery', () => {
  it('returns 404 when no gallery is stored', async () => {
    await env.THUMBNAILS.delete('known/gallery.json');
    expect((await get()).status).toBe(404);
  });

  it('put then get returns identical bytes with a json content type', async () => {
    const bytes = new Uint8Array(5000).map((_, i) => (i * 7) % 256);
    const res = await put(bytes);
    expect(res.status).toBe(201);
    const back = await get();
    expect(back.status).toBe(200);
    expect(back.headers.get('content-type')).toContain('application/json');
    expect(new Uint8Array(await back.arrayBuffer())).toEqual(bytes);
    expect((await env.THUMBNAILS.head('known/gallery.json'))?.httpMetadata?.contentType).toBe('application/json');
  });

  it('put replaces the previous object', async () => {
    await put('{"a":1}');
    await put('{"b":2}');
    expect(await (await get()).text()).toBe('{"b":2}');
  });

  it('rejects a missing or wrong token with 401', async () => {
    expect((await put('{}', {})).status).toBe(401);
    expect((await put('{}', auth('wrong'))).status).toBe(401);
    expect((await get({})).status).toBe(401);
    expect((await get(auth('wrong'))).status).toBe(401);
  });

  it('rejects an empty body with 400', async () => {
    expect((await put('')).status).toBe(400);
    expect((await put(null)).status).toBe(400);
  });

  it('rejects an oversize content-length with 413 and stores nothing', async () => {
    await env.THUMBNAILS.delete('known/gallery.json');
    const res = await put('{}', { ...auth(), 'Content-Length': String(64 * 1024 * 1024 + 1) });
    expect(res.status).toBe(413);
    expect(await env.THUMBNAILS.head('known/gallery.json')).toBeNull();
  });
});
