import { describe, expect, it, vi } from 'vitest';
import { fetchIndexedPhoto } from '../src/originals/lookupPhoto';

describe('fetchIndexedPhoto', () => {
  it('returns the source/path for a known photo', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ source: 'local', path: '/photos/a.jpg' }), { status: 200 }));

    const result = await fetchIndexedPhoto('https://example.workers.dev', 'photo-1', fetchMock);

    expect(result).toEqual({ source: 'local', path: '/photos/a.jpg' });
    expect(fetchMock).toHaveBeenCalledWith('https://example.workers.dev/photos/photo-1');
  });

  it('returns null for an unknown photo id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    expect(await fetchIndexedPhoto('https://example.workers.dev', 'missing', fetchMock)).toBeNull();
  });

  it('throws on any other error status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    await expect(fetchIndexedPhoto('https://example.workers.dev', 'photo-1', fetchMock)).rejects.toThrow(/500/);
  });
});
