import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareFaceImage, scanFaces } from '../src/faces/scanFaces';

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
    const cloudflareClient = { ingestFaces: vi.fn().mockResolvedValue(true) };

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
    const cloudflareClient = { ingestFaces: vi.fn().mockResolvedValue(true) };

    const count = await scanFaces(file, 'hash2', { sidecar: sidecar as any, cloudflareClient: cloudflareClient as any });

    expect(count).toBe(0);
    expect(cloudflareClient.ingestFaces).toHaveBeenCalledWith('hash2', 'buffalo_l', []);
  });
});
