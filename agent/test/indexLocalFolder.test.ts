import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256ContentHash } from '../src/hashing';
import { indexLocalFolder } from '../src/indexLocalFolder';
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
};

describe('indexLocalFolder', () => {
  let dir: string;
  let knownFile: string;
  let newFile: string;
  let failingFile: string;
  let knownHash: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pixdex-index-'));
    knownFile = path.join(dir, 'known.jpg');
    newFile = path.join(dir, 'new.jpg');
    failingFile = path.join(dir, 'failing.jpg');

    // Each file gets distinct pixel content so their content hashes differ
    // (identical pixel data would produce identical hashes, defeating the dedup test).
    const files: Array<{ file: string; background: { r: number; g: number; b: number } }> = [
      { file: knownFile, background: { r: 1, g: 2, b: 3 } },
      { file: newFile, background: { r: 10, g: 20, b: 30 } },
      { file: failingFile, background: { r: 100, g: 150, b: 200 } },
    ];
    for (const { file, background } of files) {
      await sharp({ create: { width: 100, height: 100, channels: 3, background } })
        .jpeg()
        .toFile(file);
    }
    knownHash = await sha256ContentHash(knownFile);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('skips already-known hashes, indexes new files, and counts failures without aborting', async () => {
    const cloudflareClient = {
      checkHashes: vi.fn().mockResolvedValue(new Set([knownHash])),
      ingestPhoto: vi.fn().mockImplementation((payload: { path?: string }) => {
        if (payload.path === failingFile) {
          return Promise.reject(new Error('simulated ingest failure'));
        }
        return Promise.resolve();
      }),
      uploadThumbnail: vi.fn().mockResolvedValue(undefined),
    };
    const ollamaClient = {
      chat: vi.fn().mockResolvedValue(SAMPLE_RESPONSE),
    };

    const result = await indexLocalFolder(dir, {
      cloudflareClient: cloudflareClient as any,
      ollamaClient: ollamaClient as any,
      config,
    });

    expect(result).toEqual({ total: 3, indexed: 1, skipped: 1, failed: 1 });
    expect(cloudflareClient.ingestPhoto).toHaveBeenCalledTimes(2); // new.jpg + failing.jpg (which then rejects)
    expect(cloudflareClient.uploadThumbnail).toHaveBeenCalledTimes(1); // only for new.jpg, since failing.jpg's ingestPhoto rejected first

    const newFilePayload = cloudflareClient.ingestPhoto.mock.calls.find(
      ([payload]: [{ path?: string }]) => payload.path === newFile
    )[0];
    expect(newFilePayload.modelProvider).toBe('ollama');
    expect(newFilePayload.modelName).toBe('qwen3.5:27b-mlx');
    expect(newFilePayload.subjects).toEqual(['leopard', 'big cat']);
    expect(newFilePayload.suggestedCaption).toBeTruthy();
  });
});
