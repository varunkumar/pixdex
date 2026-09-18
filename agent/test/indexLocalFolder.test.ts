import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256ContentHash } from '../src/hashing';
import { indexLocalFolder } from '../src/indexLocalFolder';
import type { AgentConfig } from '../src/config';

interface IngestPhotoPayload {
  path?: string;
  modelProvider?: string;
  modelName?: string;
  subjects?: string[];
  suggestedCaption?: string;
}

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
    // uploadThumbnail now runs before ingestPhoto, so it's called for both
    // new.jpg and failing.jpg (failing.jpg only fails at the ingestPhoto step).
    expect(cloudflareClient.uploadThumbnail).toHaveBeenCalledTimes(2);

    const newFilePayloadCall = cloudflareClient.ingestPhoto.mock.calls.find(
      (call: any[]) => (call[0] as IngestPhotoPayload).path === newFile
    );
    expect(newFilePayloadCall).toBeDefined();
    const newFilePayload = newFilePayloadCall![0];
    expect(newFilePayload.modelProvider).toBe('ollama');
    expect(newFilePayload.modelName).toBe('qwen3.5:27b-mlx');
    expect(newFilePayload.subjects).toEqual(['leopard', 'big cat']);
    expect(newFilePayload.suggestedCaption).toBeTruthy();
  });

  it('does not abort the run when a file is unreadable (dangling symlink)', async () => {
    // A dangling symlink has an image extension but fails to read: its hash
    // computation rejects. That must not abort the whole folder run.
    const brokenLink = path.join(dir, 'broken.jpg');
    await symlink(path.join(dir, 'does-not-exist.jpg'), brokenLink);

    const cloudflareClient = {
      checkHashes: vi.fn().mockResolvedValue(new Set([knownHash])),
      ingestPhoto: vi.fn().mockResolvedValue(undefined),
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

    // dir has: known.jpg (skipped), new.jpg (indexed), failing.jpg (indexed,
    // since ingestPhoto succeeds here), broken.jpg (unreadable -> failed).
    expect(result).toEqual({ total: 4, indexed: 2, skipped: 1, failed: 1 });
    // The unreadable file's hash never made it into checkHashes's input, and
    // it never reached ingestPhoto either.
    expect(cloudflareClient.checkHashes).toHaveBeenCalledWith(expect.any(Array));
    const checkedHashes = cloudflareClient.checkHashes.mock.calls[0][0] as string[];
    expect(checkedHashes).toHaveLength(3);
    expect(cloudflareClient.ingestPhoto).toHaveBeenCalledTimes(2);
  });

  it('skips in-batch duplicate content instead of re-analyzing it', async () => {
    // Two files with byte-identical content (neither known to the Worker)
    // should only be analyzed/ingested once; the second is counted as skipped.
    const dupA = path.join(dir, 'dup-a.jpg');
    const dupB = path.join(dir, 'dup-b.jpg');
    await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 5, g: 6, b: 7 } } })
      .jpeg()
      .toFile(dupA);
    const { copyFile } = await import('node:fs/promises');
    await copyFile(dupA, dupB);

    const cloudflareClient = {
      checkHashes: vi.fn().mockResolvedValue(new Set([knownHash])),
      ingestPhoto: vi.fn().mockResolvedValue(undefined),
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

    // dir has: known.jpg (skipped), new.jpg (indexed), failing.jpg (indexed,
    // since ingestPhoto succeeds here), dup-a.jpg (indexed), dup-b.jpg (skipped, dup).
    expect(result).toEqual({ total: 5, indexed: 3, skipped: 2, failed: 0 });
    expect(cloudflareClient.ingestPhoto).toHaveBeenCalledTimes(3);

    const dupPaths = cloudflareClient.ingestPhoto.mock.calls
      .map((call: any[]) => (call[0] as IngestPhotoPayload).path)
      .filter((p: string | undefined) => p === dupA || p === dupB);
    expect(dupPaths).toEqual([dupA]);
  });
});
