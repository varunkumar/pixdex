import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudflareClient, type IngestPhotoPayload } from '../src/cloudflareClient';
import type { AgentConfig } from '../src/config';

const config: AgentConfig = {
  CLOUDFLARE_API_BASE_URL: 'https://example.workers.dev',
  INGEST_TOKEN: 'secret-token',
  OLLAMA_BASE_URL: 'http://localhost:11434',
  OLLAMA_MODEL: 'qwen3.5:27b-mlx',
  ORIGINALS_PORT: 8787,
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

  it('facesPending batches 500 and unions the pending hashes', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ pending: ['hash-1'] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ pending: ['hash-550'] }), { status: 200 }));
    const hashes = Array.from({ length: 600 }, (_, i) => `hash-${i}`);

    const pending = await client.facesPending(hashes, 'buffalo_l');

    expect(pending).toEqual(new Set(['hash-1', 'hash-550']));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.workers.dev/ingest/faces/pending');
    expect(JSON.parse(init.body).model).toBe('buffalo_l');
    expect(JSON.parse(init.body).hashes).toHaveLength(500);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).hashes).toHaveLength(100);
  });

  it('relocatePhotos posts the prefixes and the dry-run flag', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ matched: 3, updated: 0 }), { status: 200 }));

    expect(await client.relocatePhotos('/a/abc', '/a/xyz', true)).toEqual({ matched: 3, updated: 0 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.workers.dev/ingest/relocate');
    expect(JSON.parse(init.body)).toEqual({ from: '/a/abc', to: '/a/xyz', dryRun: true });
  });

  it('facesUnscanned posts the model, cursor and path prefix and returns the page', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [{ contentHash: 'h1', path: '/a/1.jpg' }], nextCursor: 9 }), { status: 200 })
    );

    const page = await client.facesUnscanned('buffalo_l', { cursor: 3, pathPrefix: '/a/' });

    expect(page).toEqual({ items: [{ contentHash: 'h1', path: '/a/1.jpg' }], nextCursor: 9 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.workers.dev/ingest/faces/unscanned');
    expect(JSON.parse(init.body)).toEqual({ model: 'buffalo_l', cursor: 3, pathPrefix: '/a/' });
  });

  it('facesUnscanned throws on a failed response', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    await expect(client.facesUnscanned('buffalo_l')).rejects.toThrow('500');
  });

  it('ingestFaces posts the faces and returns the stored face ids', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ stored: 1, kept: 0, matched: 0, faceIds: ['f1'] }), { status: 200 }));
    const faces = [{ bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, detScore: 0.9, embedding: 'e' }];
    await expect(client.ingestFaces('h1', 'buffalo_l', faces)).resolves.toEqual({ faceIds: ['f1'] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.workers.dev/ingest/faces');
    expect(JSON.parse(init.body)).toEqual({ contentHash: 'h1', model: 'buffalo_l', faces });
  });

  it('ingestFaces returns null on 404', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(client.ingestFaces('h1', 'buffalo_l', [])).resolves.toBeNull();
  });

  it('ingestFaces throws on other errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    await expect(client.ingestFaces('h1', 'buffalo_l', [])).rejects.toThrow(/500/);
  });

  it('putFaceCrop sends the JPEG bytes raw to the face crop route', async () => {
    fetchMock.mockResolvedValueOnce(new Response('created', { status: 201 }));
    const jpeg = Buffer.from([1, 2, 3]);
    await client.putFaceCrop('f1', jpeg);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.workers.dev/ingest/faces/f1/crop');
    expect(init.method).toBe('PUT');
    expect(init.headers['Content-Type']).toBe('image/jpeg');
    expect(init.body).toBe(jpeg);
  });

  it('putFaceCrop throws on a failed response', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(client.putFaceCrop('f1', Buffer.from([1]))).rejects.toThrow(/503/);
  });

  it('ingestPhoto posts the payload and resolves on 201', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 201 }));
    const payload: IngestPhotoPayload = {
      id: 'photo-1',
      ownerEmail: 'owner@example.com',
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
        ownerEmail: 'owner@example.com',
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

describe('CloudflareClient known-people methods', () => {
  const mk = () => {
    const fetchMock = vi.fn();
    return { fetchMock, client: new CloudflareClient(config, fetchMock as unknown as typeof fetch) };
  };

  it('upsertKnownPeople posts people and returns the count', async () => {
    const { fetchMock, client } = mk();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ upserted: 1 }), { status: 200 }));
    const n = await client.upsertKnownPeople([{ id: 'p', name: 'P', aliases: ['a'] }]);
    expect(n).toBe(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.workers.dev/ingest/known-people');
    expect(init.headers.Authorization).toBe('Bearer secret-token');
    expect(JSON.parse(init.body)).toEqual({ people: [{ id: 'p', name: 'P', aliases: ['a'] }] });
  });

  it('faceEmbeddingsPage parses ids, exact floats and the cursor header', async () => {
    const { fetchMock, client } = mk();
    const ids = ['a'.repeat(36), 'b'.repeat(36)];
    const embs = [0, 1].map((k) => Float32Array.from({ length: 512 }, (_, i) => i * 0.001 + k + 0.1));
    const parts = ids.flatMap((id, k) => [Buffer.from(id, 'ascii'), Buffer.from(embs[k].buffer)]);
    fetchMock.mockResolvedValueOnce(
      new Response(Buffer.concat(parts), { status: 200, headers: { 'X-Next-Cursor': '42' } })
    );
    const page = await client.faceEmbeddingsPage('buffalo_l', { cursor: 7, rescore: true });
    expect(page.nextCursor).toBe(42);
    expect(page.faces.map((f) => f.id)).toEqual(ids);
    expect(Array.from(page.faces[1].embedding)).toEqual(Array.from(embs[1]));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.workers.dev/ingest/faces/embeddings');
    expect(init.headers.Authorization).toBe('Bearer secret-token');
    expect(JSON.parse(init.body)).toEqual({ model: 'buffalo_l', cursor: 7, rescore: true });
  });

  it('faceEmbeddingsPage sends limit only when given', async () => {
    const { fetchMock, client } = mk();
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(0), { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(0), { status: 200 }));
    await client.faceEmbeddingsPage('m', { limit: 25 });
    await client.faceEmbeddingsPage('m', {});
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ model: 'm', limit: 25 });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ model: 'm' });
  });

  it('faceEmbeddingsPage handles an empty body with a cursor and a last page without one', async () => {
    const { fetchMock, client } = mk();
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array(0), { status: 200, headers: { 'X-Next-Cursor': '5000' } })
    );
    expect(await client.faceEmbeddingsPage('m', {})).toEqual({ faces: [], nextCursor: 5000 });
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(0), { status: 200 }));
    expect(await client.faceEmbeddingsPage('m', {})).toEqual({ faces: [], nextCursor: undefined });
  });

  it('faceEmbeddingsPage rejects a body that is not a whole number of records', async () => {
    const { fetchMock, client } = mk();
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(10), { status: 200 }));
    await expect(client.faceEmbeddingsPage('m', {})).rejects.toThrow();
  });

  it('setFaceKnown posts matches (null clears) and returns updated', async () => {
    const { fetchMock, client } = mk();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ updated: 2 }), { status: 200 }));
    const matches = [
      { faceId: 'f1', knownId: 'p', score: 0.8 },
      { faceId: 'f2', knownId: null },
    ];
    expect(await client.setFaceKnown(matches)).toBe(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.workers.dev/ingest/faces/known');
    expect(JSON.parse(init.body)).toEqual({ matches });
  });

  it('throws on a failed response', async () => {
    const { fetchMock, client } = mk();
    fetchMock.mockResolvedValueOnce(new Response('x', { status: 500 }));
    await expect(client.setFaceKnown([{ faceId: 'f', knownId: null }])).rejects.toThrow(/500/);
  });
});
