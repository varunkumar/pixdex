import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processFile } from '../src/processFile';
import { parseGazetteer } from '../src/places/gazetteer';
import type { AgentConfig } from '../src/config';

const SAMPLE_RESPONSE = `SUBJECTS: leopard, big cat

COLORS: gold

PATTERNS: spots

SEASON: winter

ENVIRONMENT: forest

TAGS: leopard, big cat

DESCRIPTION: A leopard in a tree.`;

const config: AgentConfig = {
  CLOUDFLARE_API_BASE_URL: 'https://example.workers.dev',
  INGEST_TOKEN: 'secret-token',
  OWNER_EMAIL: 'Owner@Example.com',
  OLLAMA_BASE_URL: 'http://localhost:11434',
  OLLAMA_MODEL: 'qwen3.5:27b-mlx',
  ORIGINALS_PORT: 8787,
};

describe('processFile', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pixdex-process-'));
    filePath = path.join(dir, 'fixture.jpg');
    await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .jpeg()
      .toFile(filePath);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('uploads the thumbnail before ingesting metadata, for a local-source file', async () => {
    const calls: string[] = [];
    const cloudflareClient = {
      uploadThumbnail: vi.fn().mockImplementation(async () => {
        calls.push('uploadThumbnail');
      }),
      ingestPhoto: vi.fn().mockImplementation(async () => {
        calls.push('ingestPhoto');
      }),
    };
    const ollamaClient = { chat: vi.fn().mockResolvedValue(SAMPLE_RESPONSE) };

    await processFile(
      {
        localPath: filePath,
        contentHash: 'a'.repeat(64),
        source: 'local',
        sourcePath: filePath,
        filename: 'fixture.jpg',
      },
      { cloudflareClient: cloudflareClient as any, ollamaClient: ollamaClient as any, config }
    );

    expect(calls).toEqual(['uploadThumbnail', 'ingestPhoto']);
    const payload = cloudflareClient.ingestPhoto.mock.calls[0][0];
    expect(payload.source).toBe('local');
    expect(payload.ownerEmail).toBe('owner@example.com');
    expect(payload.path).toBe(filePath);
    expect(payload.driveFileId).toBeUndefined();
    expect(payload.modelProvider).toBe('ollama');
    expect(payload.subjects).toEqual(['leopard', 'big cat']);
  });

  it('sends the town name only with a town list and a GPS position', async () => {
    const gazetteer = parseGazetteer(['1', 'Gundlupet', 'Gundlupet', '', '11.81', '76.69', 'P', 'PPL', 'IN'].join('\t'));
    const withGps = path.join(dir, 'gps.jpg');
    await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 3, g: 2, b: 1 } } })
      .jpeg()
      .withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '11/1 40/1 12/1', GPSLongitudeRef: 'E', GPSLongitude: '76/1 37/1 48/1' } })
      .toFile(withGps);
    const send = async (localPath: string, town: boolean) => {
      const cloudflareClient = { uploadThumbnail: vi.fn(), ingestPhoto: vi.fn() };
      await processFile(
        { localPath, contentHash: 'b'.repeat(64), source: 'local', sourcePath: localPath, filename: 'gps.jpg' },
        {
          cloudflareClient: cloudflareClient as any,
          ollamaClient: { chat: vi.fn().mockResolvedValue(SAMPLE_RESPONSE) } as any,
          config,
          gazetteer: town ? gazetteer : undefined,
        }
      );
      return cloudflareClient.ingestPhoto.mock.calls[0][0];
    };
    expect((await send(withGps, true)).place).toBe('Gundlupet, IN');
    expect(await send(withGps, false)).not.toHaveProperty('place');
    expect(await send(filePath, true)).not.toHaveProperty('place');
  });

  it('returns per-stage timings, with the model stages measured and absent stages at 0', async () => {
    const ollamaClient = {
      chat: vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return SAMPLE_RESPONSE;
      }),
    };
    const cloudflareClient = {
      uploadThumbnail: vi.fn().mockResolvedValue(undefined),
      ingestPhoto: vi.fn().mockResolvedValue(undefined),
    };

    const timings = await processFile(
      { localPath: filePath, contentHash: 'b'.repeat(64), source: 'local', filename: 'fixture.jpg' },
      { cloudflareClient: cloudflareClient as any, ollamaClient: ollamaClient as any, config }
    );

    expect(Object.keys(timings).sort()).toEqual(
      ['analyze', 'caption', 'exif', 'faces', 'hashtags', 'ingest', 'rate', 'species', 'thumbnail'].sort()
    );
    expect(timings.analyze).toBeGreaterThanOrEqual(10);
    expect(timings.rate).toBeGreaterThanOrEqual(10);
    expect(timings.caption).toBeGreaterThanOrEqual(10);
    expect(timings.hashtags).toBeGreaterThanOrEqual(10);
    expect(timings.species).toBe(0); // species off
    expect(timings.faces).toBe(0); // no sidecar
  });

  it('starts the face and species sidecars before the vision model answers, and still uses its subjects for species', async () => {
    const events: string[] = [];
    const cloudflareClient = {
      uploadThumbnail: vi.fn().mockResolvedValue(undefined),
      ingestPhoto: vi.fn().mockResolvedValue(undefined),
      ingestFaces: vi.fn().mockResolvedValue({ faceIds: [] }),
    };
    let first = true;
    const ollamaClient = {
      chat: vi.fn().mockImplementation(async () => {
        if (first) {
          first = false;
          await vi.waitFor(() => expect(events).toEqual(expect.arrayContaining(['detect', 'identify'])));
          events.push('analyze-done');
        }
        return SAMPLE_RESPONSE;
      }),
    };
    const faceSidecar = {
      detect: vi.fn().mockImplementation(async () => {
        events.push('detect');
        return { model: 'buffalo_l', width: 100, height: 100, faces: [] };
      }),
    };
    // A 0.6 whole-frame answer is kept only with an animal cue from the vision model ("leopard").
    const identify = vi.fn().mockImplementation(async () => {
      events.push('identify');
      return { model: 'bioclip-2', whole: [['Leopard', 'Panthera pardus', 'Mammalia', 0.6]], boxes: [] };
    });
    const regions = { default: 'IN', regions: { IN: { country: 'IN' } }, rules: [] };

    await processFile(
      { localPath: filePath, contentHash: '9'.repeat(64), source: 'local', filename: 'fixture.jpg' },
      { cloudflareClient: cloudflareClient as any, ollamaClient: ollamaClient as any, config, faceSidecar: faceSidecar as any, species: { sidecar: { identify } as any, regions } }
    );

    expect(events.indexOf('analyze-done')).toBeGreaterThan(events.indexOf('detect'));
    expect(events.indexOf('analyze-done')).toBeGreaterThan(events.indexOf('identify'));
    expect(cloudflareClient.ingestPhoto.mock.calls[0][0].species).toEqual([
      { common: 'Leopard', scientific: 'Panthera pardus', score: 0.6 },
    ]);
    expect(cloudflareClient.ingestFaces).toHaveBeenCalled();
  });

  it('does not leave an unhandled rejection when a sidecar fails and the model call throws first', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const cloudflareClient = { uploadThumbnail: vi.fn(), ingestPhoto: vi.fn() };
    const ollamaClient = { chat: vi.fn().mockRejectedValue(new Error('ollama down')) };
    const faceSidecar = { detect: vi.fn().mockRejectedValue(new Error('face down')) };
    await expect(
      processFile(
        { localPath: filePath, contentHash: '8'.repeat(64), source: 'local', filename: 'fixture.jpg' },
        { cloudflareClient: cloudflareClient as any, ollamaClient: ollamaClient as any, config, faceSidecar: faceSidecar as any }
      )
    ).rejects.toThrow(/ollama down/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('refuses to index, before any model call, when OWNER_EMAIL is not set', async () => {
    const cloudflareClient = { uploadThumbnail: vi.fn(), ingestPhoto: vi.fn() };
    const ollamaClient = { chat: vi.fn() };
    await expect(
      processFile(
        { localPath: filePath, contentHash: 'a'.repeat(64), source: 'local', filename: 'fixture.jpg' },
        { cloudflareClient: cloudflareClient as any, ollamaClient: ollamaClient as any, config: { ...config, OWNER_EMAIL: undefined } }
      )
    ).rejects.toThrow(/OWNER_EMAIL/);
    expect(ollamaClient.chat).not.toHaveBeenCalled();
    expect(cloudflareClient.ingestPhoto).not.toHaveBeenCalled();
  });

  it('sets driveFileId and omits path for a google_drive-source file', async () => {
    const cloudflareClient = {
      uploadThumbnail: vi.fn().mockResolvedValue(undefined),
      ingestPhoto: vi.fn().mockResolvedValue(undefined),
    };
    const ollamaClient = { chat: vi.fn().mockResolvedValue(SAMPLE_RESPONSE) };

    await processFile(
      {
        localPath: filePath,
        contentHash: 'b'.repeat(64),
        source: 'google_drive',
        driveFileId: 'drive-file-1',
        filename: 'fixture.jpg',
        album: 'Kanha Trip',
      },
      { cloudflareClient: cloudflareClient as any, ollamaClient: ollamaClient as any, config }
    );

    const payload = cloudflareClient.ingestPhoto.mock.calls[0][0];
    expect(payload.source).toBe('google_drive');
    expect(payload.driveFileId).toBe('drive-file-1');
    expect(payload.path).toBeUndefined();
    expect(payload.album).toBe('Kanha Trip');
  });

  it('does not fail when the sidecar is down', async () => {
    const cloudflareClient = {
      uploadThumbnail: vi.fn().mockResolvedValue(undefined),
      ingestPhoto: vi.fn().mockResolvedValue(undefined),
      ingestFaces: vi.fn(),
    };
    const ollamaClient = { chat: vi.fn().mockResolvedValue(SAMPLE_RESPONSE) };
    const faceSidecar = { detect: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      processFile(
        { localPath: filePath, contentHash: 'c'.repeat(64), source: 'local', filename: 'fixture.jpg' },
        { cloudflareClient: cloudflareClient as any, ollamaClient: ollamaClient as any, config, faceSidecar: faceSidecar as any }
      )
    ).resolves.toHaveProperty('analyze');

    expect(cloudflareClient.ingestPhoto).toHaveBeenCalled();
    expect(faceSidecar.detect).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
    warn.mockRestore();
  });

  it('scans faces after ingesting the photo when a sidecar is configured', async () => {
    const calls: string[] = [];
    const cloudflareClient = {
      uploadThumbnail: vi.fn().mockResolvedValue(undefined),
      ingestPhoto: vi.fn().mockImplementation(async () => void calls.push('ingestPhoto')),
      ingestFaces: vi.fn().mockImplementation(async () => (calls.push('ingestFaces'), { faceIds: [] })),
    };
    const ollamaClient = { chat: vi.fn().mockResolvedValue(SAMPLE_RESPONSE) };
    const faceSidecar = { detect: vi.fn().mockResolvedValue({ model: 'buffalo_l', width: 100, height: 100, faces: [] }) };

    await processFile(
      { localPath: filePath, contentHash: 'd'.repeat(64), source: 'local', filename: 'fixture.jpg' },
      { cloudflareClient: cloudflareClient as any, ollamaClient: ollamaClient as any, config, faceSidecar: faceSidecar as any }
    );

    expect(calls).toEqual(['ingestPhoto', 'ingestFaces']);
  });

  describe('species', () => {
    const regions = { default: 'IN', regions: { IN: { country: 'IN' } }, rules: [] };
    const tiger = { model: 'bioclip-2', whole: [['Tiger', 'Panthera tigris', 'Mammalia', 0.97]], boxes: [] };
    const fresh = () => ({
      cloudflareClient: { uploadThumbnail: vi.fn().mockResolvedValue(undefined), ingestPhoto: vi.fn().mockResolvedValue(undefined) },
      ollamaClient: { chat: vi.fn().mockResolvedValue(SAMPLE_RESPONSE) },
    });
    const input = () => ({ localPath: filePath, contentHash: 'f'.repeat(64), source: 'local' as const, filename: 'fixture.jpg', album: 'Kanha' });

    it('sends the species with the photo so it is indexed in one write', async () => {
      const { cloudflareClient, ollamaClient } = fresh();
      const identify = vi.fn().mockResolvedValue(tiger);
      await processFile(input(), { cloudflareClient: cloudflareClient as any, ollamaClient: ollamaClient as any, config, species: { sidecar: { identify } as any, regions } });
      const payload = cloudflareClient.ingestPhoto.mock.calls[0][0];
      expect(payload.species).toEqual([{ common: 'Tiger', scientific: 'Panthera tigris', score: 0.97 }]);
      expect(payload.speciesModel).toBe('bioclip-2');
    });

    it('sends an empty list (scanned, nothing confident) rather than nothing', async () => {
      const { cloudflareClient, ollamaClient } = fresh();
      const identify = vi.fn().mockResolvedValue({ model: 'bioclip-2', whole: [], boxes: [] });
      await processFile(input(), { cloudflareClient: cloudflareClient as any, ollamaClient: ollamaClient as any, config, species: { sidecar: { identify } as any, regions } });
      const payload = cloudflareClient.ingestPhoto.mock.calls[0][0];
      expect(payload.species).toEqual([]);
      expect(payload.speciesModel).toBe('bioclip-2');
    });

    it('does not fail the photo when the sidecar is down; it is left for backfill-species', async () => {
      const { cloudflareClient, ollamaClient } = fresh();
      const identify = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await expect(
        processFile(input(), { cloudflareClient: cloudflareClient as any, ollamaClient: ollamaClient as any, config, species: { sidecar: { identify } as any, regions } })
      ).resolves.toHaveProperty('analyze');
      const payload = cloudflareClient.ingestPhoto.mock.calls[0][0];
      expect(payload.species).toBeUndefined();
      expect(payload.speciesModel).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
      warn.mockRestore();
    });

    it('sends no species fields when species scanning is not configured', async () => {
      const { cloudflareClient, ollamaClient } = fresh();
      await processFile(input(), { cloudflareClient: cloudflareClient as any, ollamaClient: ollamaClient as any, config });
      const payload = cloudflareClient.ingestPhoto.mock.calls[0][0];
      expect('species' in payload).toBe(false);
      expect('speciesModel' in payload).toBe(false);
    });
  });

  it('skips scanning when no sidecar is configured', async () => {
    const cloudflareClient = {
      uploadThumbnail: vi.fn().mockResolvedValue(undefined),
      ingestPhoto: vi.fn().mockResolvedValue(undefined),
      ingestFaces: vi.fn(),
    };
    const ollamaClient = { chat: vi.fn().mockResolvedValue(SAMPLE_RESPONSE) };

    await processFile(
      { localPath: filePath, contentHash: 'e'.repeat(64), source: 'local', filename: 'fixture.jpg' },
      { cloudflareClient: cloudflareClient as any, ollamaClient: ollamaClient as any, config }
    );

    expect(cloudflareClient.ingestFaces).not.toHaveBeenCalled();
  });
});
