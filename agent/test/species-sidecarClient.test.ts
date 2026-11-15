import { describe, expect, it, vi } from 'vitest';
import { createSpeciesSidecar, SpeciesSidecarClient } from '../src/species/sidecarClient';

describe('SpeciesSidecarClient', () => {
  it('posts the jpeg with the region and returns the raw candidates', async () => {
    const body = { model: 'bioclip-2', whole: [['Tiger', 'Panthera tigris', 'Mammalia', 0.9]], boxes: [] };
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const client = new SpeciesSidecarClient('http://127.0.0.1:8800/', fetchFn as unknown as typeof fetch);

    await expect(client.identify(Buffer.from([1, 2, 3]), 'IN-KA')).resolves.toEqual(body);

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8800/species?region=IN-KA');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('image/jpeg');
    expect(Buffer.from(init.body)).toEqual(Buffer.from([1, 2, 3]));
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws on a failed response', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    const client = new SpeciesSidecarClient('http://127.0.0.1:8800', fetchFn as unknown as typeof fetch);
    await expect(client.identify(Buffer.from([1]), 'IN')).rejects.toThrow(/500/);
  });

  it('reads the model name from /health', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, model: 'bioclip-2' }), { status: 200 }));
    const client = new SpeciesSidecarClient('http://127.0.0.1:8800', fetchFn as unknown as typeof fetch);
    await expect(client.model()).resolves.toBe('bioclip-2');
    expect(fetchFn.mock.calls[0][0]).toBe('http://127.0.0.1:8800/health');
  });

  it('is only created when SPECIES_SIDECAR_URL is set', () => {
    expect(createSpeciesSidecar({})).toBeUndefined();
    expect(createSpeciesSidecar({ SPECIES_SIDECAR_URL: 'http://127.0.0.1:8800' })).toBeInstanceOf(SpeciesSidecarClient);
  });
});
