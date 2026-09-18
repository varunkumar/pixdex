import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudflareClient, type IngestPhotoPayload } from '../src/cloudflareClient';
import type { AgentConfig } from '../src/config';

const config: AgentConfig = {
  CLOUDFLARE_API_BASE_URL: 'https://example.workers.dev',
  INGEST_TOKEN: 'secret-token',
  OLLAMA_BASE_URL: 'http://localhost:11434',
  OLLAMA_MODEL: 'qwen3.5:27b-mlx',
};

describe('CloudflareClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: CloudflareClient;

  beforeEach(() => {
    fetchMock = vi.fn();
    client = new CloudflareClient(config, fetchMock as unknown as typeof fetch);
  });

  it('checkHashes posts to /ingest/check-hashes with the bearer token', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ known: ['h1'] }), { status: 200 })
    );

    const known = await client.checkHashes(['h1', 'h2']);

    expect(known).toEqual(new Set(['h1']));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.workers.dev/ingest/check-hashes');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer secret-token');
    expect(JSON.parse(init.body)).toEqual({ hashes: ['h1', 'h2'] });
  });

  it('checkHashes batches requests in chunks of 500', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ known: [] }), { status: 200 }));
    const hashes = Array.from({ length: 600 }, (_, i) => `hash-${i}`);

    await client.checkHashes(hashes);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).hashes).toHaveLength(500);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).hashes).toHaveLength(100);
  });

  it('ingestPhoto posts the payload and resolves on 201', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 201 }));
    const payload: IngestPhotoPayload = {
      id: 'photo-1',
      contentHash: 'a'.repeat(64),
      source: 'local',
      filename: 'a.jpg',
      subjects: ['leopard'],
      colors: [],
      patterns: [],
      tags: ['leopard', 'big cat'],
      description: 'desc',
      suggestedCaption: 'caption',
      suggestedHashtags: ['leopard'],
      modelProvider: 'ollama',
      modelName: 'qwen3.5:27b-mlx',
    };

    await expect(client.ingestPhoto(payload)).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.workers.dev/ingest/photo');
    expect(JSON.parse(init.body).contentHash).toBe('a'.repeat(64));
  });

  it('ingestPhoto throws on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 409 }));
    await expect(
      client.ingestPhoto({
        id: 'x',
        contentHash: 'a'.repeat(64),
        source: 'local',
        filename: 'a.jpg',
        subjects: [],
        colors: [],
        patterns: [],
        tags: [],
        description: '',
        suggestedCaption: '',
        suggestedHashtags: [],
        modelProvider: 'ollama',
        modelName: 'qwen3.5:27b-mlx',
      })
    ).rejects.toThrow(/ingest\/photo failed: 409/);
  });

  it('uploadThumbnail PUTs raw bytes with an image/jpeg content type', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 201 }));
    const bytes = Buffer.from([1, 2, 3]);

    await client.uploadThumbnail('a'.repeat(64), bytes);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://example.workers.dev/ingest/thumbnail/${'a'.repeat(64)}`);
    expect(init.method).toBe('PUT');
    expect(init.headers['Content-Type']).toBe('image/jpeg');
    expect(init.body).toBe(bytes);
  });
});
