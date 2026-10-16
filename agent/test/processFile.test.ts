import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processFile } from '../src/processFile';
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
    expect(payload.path).toBe(filePath);
    expect(payload.driveFileId).toBeUndefined();
    expect(payload.modelProvider).toBe('ollama');
    expect(payload.subjects).toEqual(['leopard', 'big cat']);
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
    ).resolves.toBeUndefined();

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
