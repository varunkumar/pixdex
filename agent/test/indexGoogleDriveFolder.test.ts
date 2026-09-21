import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { indexGoogleDriveFolder } from '../src/google/indexGoogleDriveFolder';
import type { DriveFilesClient } from '../src/google/driveFiles';
import type { AgentConfig } from '../src/config';

const config: AgentConfig = {
  CLOUDFLARE_API_BASE_URL: 'https://example.workers.dev',
  INGEST_TOKEN: 'secret-token',
  OLLAMA_BASE_URL: 'http://localhost:11434',
  OLLAMA_MODEL: 'qwen3.5:27b-mlx',
  ORIGINALS_PORT: 8787,
};

const SAMPLE_RESPONSE = `SUBJECTS: leopard

COLORS: gold

PATTERNS: spots

SEASON: winter

ENVIRONMENT: forest

TAGS: leopard

DESCRIPTION: A leopard.`;

// Real, decodable JPEG bytes are needed for tests that exercise the full
// success path through processFile (sharp/exifr must be able to read the
// downloaded file). Distinct backgrounds give distinct content hashes.
async function makeJpeg(background: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width: 20, height: 20, channels: 3, background } })
    .jpeg()
    .toBuffer();
}

describe('indexGoogleDriveFolder', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'pixdex-drive-index-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('downloads, dedup-checks, processes, and cleans up each Drive image, skipping known hashes', async () => {
    const driveClient: DriveFilesClient = {
      list: vi.fn().mockResolvedValue({
        data: {
          files: [
            { id: 'known-1', name: 'known.jpg', mimeType: 'image/jpeg' },
            { id: 'new-1', name: 'new.jpg', mimeType: 'image/jpeg' },
          ],
        },
      }),
      get: vi.fn().mockResolvedValue({ data: Readable.from([Buffer.from('fake jpeg bytes')]) }),
    };

    const cloudflareClient = {
      checkHashes: vi.fn().mockImplementation(async (hashes: string[]) => {
        // Every file downloads to identical bytes in this test, so both
        // hashes are identical too — first call (known.jpg) reports it as
        // known; that hash then stays "known" for new.jpg as well, which
        // is fine: it correctly proves cross-file dedup within one run.
        return new Set(hashes);
      }),
      uploadThumbnail: vi.fn().mockResolvedValue(undefined),
      ingestPhoto: vi.fn().mockResolvedValue(undefined),
    };
    const ollamaClient = { chat: vi.fn().mockResolvedValue(SAMPLE_RESPONSE) };

    const result = await indexGoogleDriveFolder(driveClient, 'folder-1', 'Kanha 2026', {
      cloudflareClient: cloudflareClient as any,
      ollamaClient: ollamaClient as any,
      config,
      tempDir: tempRoot,
    });

    expect(result).toEqual({ total: 2, indexed: 0, skipped: 2, failed: 0 });
    expect(cloudflareClient.ingestPhoto).not.toHaveBeenCalled();

    const leftoverFiles = await readdir(tempRoot);
    expect(leftoverFiles).toHaveLength(0); // every downloaded temp file was cleaned up
  });

  it('cleans up the temp file even when processing fails', async () => {
    const driveClient: DriveFilesClient = {
      list: vi.fn().mockResolvedValue({
        data: { files: [{ id: 'broken-1', name: 'broken.jpg', mimeType: 'image/jpeg' }] },
      }),
      get: vi.fn().mockResolvedValue({ data: Readable.from([Buffer.from('fake jpeg bytes')]) }),
    };
    const cloudflareClient = {
      checkHashes: vi.fn().mockResolvedValue(new Set()),
      uploadThumbnail: vi.fn().mockRejectedValue(new Error('network error')),
      ingestPhoto: vi.fn(),
    };
    const ollamaClient = { chat: vi.fn().mockResolvedValue(SAMPLE_RESPONSE) };

    const result = await indexGoogleDriveFolder(driveClient, 'folder-1', 'Kanha 2026', {
      cloudflareClient: cloudflareClient as any,
      ollamaClient: ollamaClient as any,
      config,
      tempDir: tempRoot,
    });

    expect(result).toEqual({ total: 1, indexed: 0, skipped: 0, failed: 1 });
    expect(await readdir(tempRoot)).toHaveLength(0);
  });

  it('indexes a new (dedup-miss) file all the way through processFile', async () => {
    const jpegBytes = await makeJpeg({ r: 40, g: 80, b: 120 });
    const driveClient: DriveFilesClient = {
      list: vi.fn().mockResolvedValue({
        data: { files: [{ id: 'new-drive-id', name: 'new-photo.jpg', mimeType: 'image/jpeg' }] },
      }),
      get: vi.fn().mockResolvedValue({ data: Readable.from([jpegBytes]) }),
    };
    const cloudflareClient = {
      checkHashes: vi.fn().mockResolvedValue(new Set()),
      uploadThumbnail: vi.fn().mockResolvedValue(undefined),
      ingestPhoto: vi.fn().mockResolvedValue(undefined),
    };
    const ollamaClient = { chat: vi.fn().mockResolvedValue(SAMPLE_RESPONSE) };

    const result = await indexGoogleDriveFolder(driveClient, 'folder-1', 'Kanha 2026', {
      cloudflareClient: cloudflareClient as any,
      ollamaClient: ollamaClient as any,
      config,
      tempDir: tempRoot,
    });

    expect(result).toEqual({ total: 1, indexed: 1, skipped: 0, failed: 0 });
    expect(cloudflareClient.ingestPhoto).toHaveBeenCalledTimes(1);
    expect(cloudflareClient.ingestPhoto).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'google_drive',
        driveFileId: 'new-drive-id',
        filename: 'new-photo.jpg',
        album: 'Kanha 2026',
      })
    );
    expect(await readdir(tempRoot)).toHaveLength(0);
  });

  it('continues indexing subsequent files after one file fails', async () => {
    const [firstBytes, secondBytes, thirdBytes] = await Promise.all([
      makeJpeg({ r: 10, g: 20, b: 30 }),
      makeJpeg({ r: 90, g: 100, b: 110 }),
      makeJpeg({ r: 200, g: 210, b: 220 }),
    ]);
    const driveClient: DriveFilesClient = {
      list: vi.fn().mockResolvedValue({
        data: {
          files: [
            { id: 'ok-1', name: 'first.jpg', mimeType: 'image/jpeg' },
            { id: 'broken-1', name: 'second.jpg', mimeType: 'image/jpeg' },
            { id: 'ok-2', name: 'third.jpg', mimeType: 'image/jpeg' },
          ],
        },
      }),
      get: vi
        .fn()
        .mockResolvedValueOnce({ data: Readable.from([firstBytes]) })
        .mockResolvedValueOnce({ data: Readable.from([secondBytes]) })
        .mockResolvedValueOnce({ data: Readable.from([thirdBytes]) }),
    };
    const cloudflareClient = {
      checkHashes: vi.fn().mockResolvedValue(new Set()),
      uploadThumbnail: vi
        .fn()
        .mockResolvedValueOnce(undefined) // first.jpg succeeds
        .mockRejectedValueOnce(new Error('network error')) // second.jpg fails
        .mockResolvedValueOnce(undefined), // third.jpg succeeds
      ingestPhoto: vi.fn().mockResolvedValue(undefined),
    };
    const ollamaClient = { chat: vi.fn().mockResolvedValue(SAMPLE_RESPONSE) };

    const result = await indexGoogleDriveFolder(driveClient, 'folder-1', 'Kanha 2026', {
      cloudflareClient: cloudflareClient as any,
      ollamaClient: ollamaClient as any,
      config,
      tempDir: tempRoot,
    });

    expect(result).toEqual({ total: 3, indexed: 2, skipped: 0, failed: 1 });
    expect(driveClient.get).toHaveBeenCalledTimes(3);
    expect(await readdir(tempRoot)).toHaveLength(0);
  });
});
