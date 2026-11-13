import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_FACES_PER_PHOTO, cropFace, prepareFaceImage, scanFaces, uprightBoxToRaw } from '../src/faces/scanFaces';

describe('scanFaces', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pixdex-faces-'));
    file = path.join(dir, 'big.jpg');
    await sharp({ create: { width: 2560, height: 1280, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .jpeg()
      .toFile(file);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('prepareFaceImage caps the longest side at 1280', async () => {
    const meta = await sharp(await prepareFaceImage(file)).metadata();
    expect(meta.width).toBe(1280);
    expect(meta.height).toBe(640);
    expect(meta.format).toBe('jpeg');
  });

  it('converts pixel boxes to normalised boxes and posts them', async () => {
    const sidecar = {
      detect: vi.fn().mockResolvedValue({
        model: 'buffalo_l',
        width: 1280,
        height: 640,
        faces: [
          { bbox: [128, 64, 384, 320], detScore: 0.95, embedding: 'emb1' },
          { bbox: [-10, 600, 1300, 700], detScore: 0.7, embedding: 'emb2' },
        ],
      }),
    };
    const cloudflareClient = { ingestFaces: vi.fn().mockResolvedValue({ faceIds: [] }) };

    const count = await scanFaces(file, 'hash1', { sidecar: sidecar as any, cloudflareClient: cloudflareClient as any });

    expect(count).toBe(2);
    const [hash, model, faces] = cloudflareClient.ingestFaces.mock.calls[0];
    expect([hash, model]).toEqual(['hash1', 'buffalo_l']);
    const close = (actual: Record<string, number>, expected: Record<string, number>) =>
      Object.entries(expected).forEach(([k, v]) => expect(actual[k]).toBeCloseTo(v, 6));
    close(faces[0].bbox, { x: 0.1, y: 0.1, w: 0.2, h: 0.4 });
    close(faces[1].bbox, { x: 0, y: 600 / 640, w: 1, h: 40 / 640 });
    expect(faces.map((f: any) => [f.detScore, f.embedding])).toEqual([[0.95, 'emb1'], [0.7, 'emb2']]);
  });

  it('posts an empty list for a photo with no faces', async () => {
    const sidecar = { detect: vi.fn().mockResolvedValue({ model: 'buffalo_l', width: 1280, height: 640, faces: [] }) };
    const cloudflareClient = { ingestFaces: vi.fn().mockResolvedValue({ faceIds: [] }) };

    const count = await scanFaces(file, 'hash2', { sidecar: sidecar as any, cloudflareClient: cloudflareClient as any });

    expect(count).toBe(0);
    expect(cloudflareClient.ingestFaces).toHaveBeenCalledWith('hash2', 'buffalo_l', []);
  });

  const near = (actual: object, expected: Record<string, number>) =>
    Object.entries(expected).forEach(([k, v]) => expect((actual as Record<string, number>)[k]).toBeCloseTo(v, 6));

  it.each([
    [6, { x: 0.2, y: 0.7, w: 0.3, h: 0.2 }],
    [8, { x: 0.5, y: 0.1, w: 0.3, h: 0.2 }],
    [3, { x: 0.7, y: 0.5, w: 0.2, h: 0.3 }],
    [1, { x: 0.1, y: 0.2, w: 0.2, h: 0.3 }],
  ])('maps an upright box into the raw frame for orientation %i', (orientation, expected) => {
    near(uprightBoxToRaw({ x: 0.1, y: 0.2, w: 0.2, h: 0.3 }, orientation), expected);
  });

  it('maps undefined orientation to identity', () => {
    near(uprightBoxToRaw({ x: 0.1, y: 0.2, w: 0.2, h: 0.3 }, undefined), { x: 0.1, y: 0.2, w: 0.2, h: 0.3 });
  });

  it('writes raw-frame boxes for a file with EXIF orientation 6', async () => {
    const rotated = path.join(dir, 'rot.jpg');
    await sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toFile(rotated);
    // Upright image is 100 x 200.
    const sidecar = {
      detect: vi.fn().mockResolvedValue({
        model: 'm',
        width: 100,
        height: 200,
        faces: [{ bbox: [10, 40, 30, 100], detScore: 0.9, embedding: 'e' }],
      }),
    };
    const cloudflareClient = { ingestFaces: vi.fn().mockResolvedValue({ faceIds: [] }) };
    await scanFaces(rotated, 'h', { sidecar: sidecar as any, cloudflareClient: cloudflareClient as any });
    near(cloudflareClient.ingestFaces.mock.calls[0][2][0].bbox, { x: 0.2, y: 0.7, w: 0.3, h: 0.2 });
  });

  it('writes upright-frame boxes unchanged with boxFrame upright, matching an upright thumbnail', async () => {
    const rotated = path.join(dir, 'rot2.jpg');
    await sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toFile(rotated);
    const sidecar = {
      detect: vi.fn().mockResolvedValue({
        model: 'm',
        width: 100,
        height: 200,
        faces: [{ bbox: [10, 40, 30, 100], detScore: 0.9, embedding: 'e' }],
      }),
    };
    const cloudflareClient = { ingestFaces: vi.fn().mockResolvedValue({ faceIds: [] }) };
    await scanFaces(rotated, 'h', { sidecar: sidecar as any, cloudflareClient: cloudflareClient as any, boxFrame: 'upright' });
    near(cloudflareClient.ingestFaces.mock.calls[0][2][0].bbox, { x: 0.1, y: 0.2, w: 0.2, h: 0.3 });
  });

  it('keeps only the largest faces when there are more than the per-request cap', async () => {
    const faces = Array.from({ length: MAX_FACES_PER_PHOTO + 5 }, (_, i) => ({
      bbox: [0, 0, 10 + i, 10 + i],
      detScore: 0.9,
      embedding: `e${i}`,
    }));
    const sidecar = { detect: vi.fn().mockResolvedValue({ model: 'm', width: 1280, height: 640, faces }) };
    const cloudflareClient = { ingestFaces: vi.fn().mockResolvedValue({ faceIds: [] }) };
    const count = await scanFaces(file, 'h', { sidecar: sidecar as any, cloudflareClient: cloudflareClient as any });
    expect(count).toBe(MAX_FACES_PER_PHOTO);
    const sent = cloudflareClient.ingestFaces.mock.calls[0][2];
    expect(sent).toHaveLength(MAX_FACES_PER_PHOTO);
    expect(sent.some((f: any) => f.embedding === 'e0')).toBe(false);
    expect(sent.some((f: any) => f.embedding === `e${MAX_FACES_PER_PHOTO + 4}`)).toBe(true);
  });

  it('uploads a 192 px square crop per stored face after ingest, not inside the ingest body', async () => {
    const sidecar = {
      detect: vi.fn().mockResolvedValue({
        model: 'buffalo_l',
        width: 1280,
        height: 640,
        faces: [
          { bbox: [128, 64, 384, 320], detScore: 0.95, embedding: 'emb1' },
          { bbox: [640, 64, 768, 192], detScore: 0.9, embedding: 'emb2' },
        ],
      }),
    };
    const cloudflareClient = {
      ingestFaces: vi.fn().mockResolvedValue({ faceIds: ['fa', 'fb'] }),
      putFaceCrop: vi.fn().mockResolvedValue(undefined),
    };

    await scanFaces(file, 'hash3', { sidecar: sidecar as any, cloudflareClient: cloudflareClient as any });

    const [, , faces] = cloudflareClient.ingestFaces.mock.calls[0];
    expect(faces.every((f: any) => !('crop' in f))).toBe(true);
    expect(cloudflareClient.putFaceCrop.mock.calls.map((c) => c[0])).toEqual(['fa', 'fb']);
    const meta = await sharp(cloudflareClient.putFaceCrop.mock.calls[0][1]).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 192, 192]);
  });

  it('still succeeds when a crop upload fails', async () => {
    const sidecar = {
      detect: vi.fn().mockResolvedValue({
        model: 'buffalo_l',
        width: 1280,
        height: 640,
        faces: [{ bbox: [128, 64, 384, 320], detScore: 0.95, embedding: 'emb1' }],
      }),
    };
    const cloudflareClient = {
      ingestFaces: vi.fn().mockResolvedValue({ faceIds: ['fa'] }),
      putFaceCrop: vi.fn().mockRejectedValue(new Error('ingest/faces/crop failed: 503')),
    };
    await expect(
      scanFaces(file, 'hash4', { sidecar: sidecar as any, cloudflareClient: cloudflareClient as any })
    ).resolves.toBe(1);
  });

  it('keeps the crop square and inside the image for a face at the edge', async () => {
    const edge = await cropFace(await sharp(file).jpeg().toBuffer(), { x: 0, y: 0.9, w: 0.05, h: 0.1 });
    const meta = await sharp(edge).metadata();
    expect([meta.width, meta.height]).toEqual([meta.width, meta.width]);
  });
});

describe('scanFaces known matching', () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pixdex-known-'));
    file = path.join(dir, 'p.jpg');
    await sharp({ create: { width: 1280, height: 640, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toFile(file);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const unit = (i: number) => {
    const v = new Float32Array(512);
    v[i] = 1;
    return v;
  };
  const b64 = (v: Float32Array) => Buffer.from(v.buffer).toString('base64');
  const gallery = (model = 'buffalo_l') => ({
    model,
    people: [
      { id: 'k1', name: 'A', aliases: [], refs: [unit(0)] },
      { id: 'k2', name: 'B', aliases: [], refs: [unit(1)] },
    ],
  });
  const detect = (embeddings: string[], model = 'buffalo_l') => ({
    detect: vi.fn().mockResolvedValue({
      model,
      width: 1280,
      height: 640,
      faces: embeddings.map((embedding, i) => ({ bbox: [0, 0, 100 + i * 10, 100 + i * 10], detScore: 0.9, embedding })),
    }),
  });
  const client = () => ({ ingestFaces: vi.fn().mockResolvedValue({ faceIds: [] }) });

  it('posts known for a face above threshold and none for one below, keeping order', async () => {
    // Faces sorted by area descending: index 1 (bigger) first.
    const sidecar = detect([b64(unit(5)), b64(unit(0))]);
    const cf = client();
    await scanFaces(file, 'h', { sidecar: sidecar as any, cloudflareClient: cf as any, gallery: gallery() });
    const faces = cf.ingestFaces.mock.calls[0][2];
    expect(faces.map((f: any) => f.embedding)).toEqual([b64(unit(0)), b64(unit(5))]);
    expect(faces[0].known).toEqual({ id: 'k1', score: expect.closeTo(1, 5) });
    expect('known' in faces[1]).toBe(false);
  });

  it('posts no known without a gallery', async () => {
    const cf = client();
    await scanFaces(file, 'h', { sidecar: detect([b64(unit(0))]) as any, cloudflareClient: cf as any });
    expect('known' in cf.ingestFaces.mock.calls[0][2][0]).toBe(false);
  });

  it('skips matching and warns once per gallery on a model mismatch, across photos', async () => {
    const g = gallery('other_model');
    const onWarning = vi.fn();
    const cf = client();
    for (let i = 0; i < 2; i++) {
      await scanFaces(file, 'h', {
        sidecar: detect([b64(unit(0)), b64(unit(1))]) as any,
        cloudflareClient: cf as any,
        gallery: g,
        onWarning,
      });
    }
    expect(onWarning).toHaveBeenCalledTimes(1);
    for (const call of cf.ingestFaces.mock.calls) expect(call[2].some((f: any) => 'known' in f)).toBe(false);
  });

  it('skips a face with an undecodable embedding without failing the others', async () => {
    const nan = new Float32Array(512).fill(NaN);
    const cf = client();
    const count = await scanFaces(file, 'h', {
      sidecar: detect([b64(nan), 'short', b64(unit(0))]) as any,
      cloudflareClient: cf as any,
      gallery: gallery(),
    });
    expect(count).toBe(3);
    const faces = cf.ingestFaces.mock.calls[0][2];
    expect(faces.filter((f: any) => 'known' in f)).toHaveLength(1);
    expect(faces.find((f: any) => 'known' in f).known.id).toBe('k1');
  });
});
