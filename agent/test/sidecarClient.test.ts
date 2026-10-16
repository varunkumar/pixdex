import { describe, expect, it, vi } from 'vitest';
import { FaceSidecarClient } from '../src/faces/sidecarClient';

describe('FaceSidecarClient', () => {
  it('posts the jpeg and returns faces', async () => {
    const body = { model: 'buffalo_l', width: 10, height: 20, faces: [{ bbox: [1, 2, 3, 4], detScore: 0.9, embedding: 'abc' }] };
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const client = new FaceSidecarClient('http://127.0.0.1:8799/', fetchFn as unknown as typeof fetch);

    const result = await client.detect(Buffer.from([1, 2, 3]));

    expect(result).toEqual(body);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8799/faces');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('image/jpeg');
    expect(Buffer.from(init.body)).toEqual(Buffer.from([1, 2, 3]));
  });

  it('throws on a 500', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    const client = new FaceSidecarClient('http://127.0.0.1:8799', fetchFn as unknown as typeof fetch);
    await expect(client.detect(Buffer.from([1]))).rejects.toThrow(/500/);
  });

  it('reads the model name from /health', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, model: 'buffalo_l' }), { status: 200 }));
    const client = new FaceSidecarClient('http://127.0.0.1:8799', fetchFn as unknown as typeof fetch);
    await expect(client.model()).resolves.toBe('buffalo_l');
    expect(fetchFn.mock.calls[0][0]).toBe('http://127.0.0.1:8799/health');
  });
});
