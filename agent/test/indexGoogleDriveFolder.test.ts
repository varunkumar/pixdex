import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
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
  OWNER_EMAIL: 'Owner@Example.com',
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

  it('skips photos Drive already reports as indexed without downloading them', async () => {
    const jpegBytes = await makeJpeg({ r: 5, g: 6, b: 7 });
    const sha = createHash('sha256').update(jpegBytes).digest('hex');
    const driveClient = {
      list: vi.fn().mockResolvedValue({
        data: { files: [{ id: 'd1', name: 'seen.jpg', mimeType: 'image/jpeg', sha256Checksum: sha.toUpperCase() }] },
      }),
      get: vi.fn(),
    } as unknown as DriveFilesClient;
    const cloudflareClient = {
      checkHashes: vi.fn().mockResolvedValue(new Set([sha])),
      uploadThumbnail: vi.fn(),
      ingestPhoto: vi.fn(),
    };
    const events: unknown[] = [];

    const result = await indexGoogleDriveFolder(driveClient, 'folder-1', 'Kanha', {
      cloudflareClient: cloudflareClient as any,
      ollamaClient: { chat: vi.fn() } as any,
      config,
      tempDir: tempRoot,
      onFile: (e) => events.push(e),
    });

    expect(result).toEqual({ total: 1, indexed: 0, skipped: 1, failed: 0 });
    expect(driveClient.get).not.toHaveBeenCalled();
    expect(cloudflareClient.checkHashes).toHaveBeenCalledTimes(1);
    expect(cloudflareClient.checkHashes).toHaveBeenCalledWith([sha]);
    expect(events).toEqual([{ file: 'seen.jpg', outcome: 'skipped' }]);
  });

  it('indexes subfolders, naming the album like local files (Processed folder uses its parent)', async () => {
    const [a, b, c] = await Promise.all([
      makeJpeg({ r: 1, g: 2, b: 3 }),
      makeJpeg({ r: 200, g: 100, b: 50 }),
      makeJpeg({ r: 9, g: 99, b: 199 }),
    ]);
    const byParent: Record<string, unknown[]> = {
      root: [
        { id: 'bandipur', name: 'Bandipur', mimeType: 'application/vnd.google-apps.folder' },
        { id: 'kanha', name: 'Kanha', mimeType: 'application/vnd.google-apps.folder' },
      ],
      bandipur: [
        { id: 'proc', name: 'Processed', mimeType: 'application/vnd.google-apps.folder' },
        { id: 'a', name: 'a.jpg', mimeType: 'image/jpeg' }, // outside Processed: ignored
      ],
      proc: [
        { id: 'b', name: 'b.jpg', mimeType: 'image/jpeg' },
        { id: 'braw', name: 'b.NEF', mimeType: 'image/x-nikon-nef' }, // RAW: ignored
      ],
      kanha: [{ id: 'c', name: 'c.jpg', mimeType: 'image/jpeg' }], // no Processed: its own photos count
    };
    const bytes: Record<string, Buffer> = { a, b, c };
    const driveClient = {
      list: vi.fn().mockImplementation(async ({ q }: { q: string }) => ({
        data: { files: byParent[/'([^']+)' in parents/.exec(q)![1]] ?? [] },
      })),
      get: vi.fn().mockImplementation(async ({ fileId }: { fileId: string }) => ({
        data: Readable.from([bytes[fileId]]),
      })),
    } as unknown as DriveFilesClient;
    const cloudflareClient = {
      checkHashes: vi.fn().mockResolvedValue(new Set()),
      uploadThumbnail: vi.fn().mockResolvedValue(undefined),
      ingestPhoto: vi.fn().mockResolvedValue(undefined),
    };

    const result = await indexGoogleDriveFolder(driveClient, 'root', 'Trips', {
      cloudflareClient: cloudflareClient as any,
      ollamaClient: { chat: vi.fn().mockResolvedValue(SAMPLE_RESPONSE) } as any,
      config,
      tempDir: tempRoot,
    });

    expect(result).toEqual({ total: 2, indexed: 2, skipped: 0, failed: 0 });
    const albums = Object.fromEntries(
      cloudflareClient.ingestPhoto.mock.calls.map(([p]) => [p.driveFileId, p.album])
    );
    expect(albums).toEqual({ b: 'Bandipur', c: 'Kanha' });
    const downloaded = (driveClient.get as ReturnType<typeof vi.fn>).mock.calls.map(([p]) => p.fileId).sort();
    expect(downloaded).toEqual(['b', 'c']); // a.jpg and the RAW file were never fetched
  });

  it('logs album, size, timings and a throughput summary for measuring speed', async () => {
    const [a, b] = await Promise.all([makeJpeg({ r: 4, g: 5, b: 6 }), makeJpeg({ r: 70, g: 80, b: 90 })]);
    const bytes: Record<string, Buffer> = { a, b };
    const driveClient = {
      list: vi.fn().mockResolvedValue({
        data: {
          files: [
            { id: 'a', name: 'a.jpg', mimeType: 'image/jpeg', size: String(2 * 1048576) },
            { id: 'b', name: 'b.jpg', mimeType: 'image/jpeg', size: String(1048576) },
          ],
        },
      }),
      get: vi.fn().mockImplementation(async ({ fileId }: { fileId: string }) => ({ data: Readable.from([bytes[fileId]]) })),
    } as unknown as DriveFilesClient;
    const cloudflareClient = {
      checkHashes: vi.fn().mockResolvedValue(new Set()),
      uploadThumbnail: vi.fn().mockResolvedValue(undefined),
      ingestPhoto: vi.fn().mockResolvedValue(undefined),
    };
    let t = 0;
    const messages: string[] = [];

    await indexGoogleDriveFolder(driveClient, 'root', 'Trips', {
      cloudflareClient: cloudflareClient as any,
      ollamaClient: { chat: vi.fn().mockResolvedValue(SAMPLE_RESPONSE) } as any,
      config,
      tempDir: tempRoot,
      now: () => (t += 10000), // every clock read is 10 s later
      onProgress: (m) => messages.push(m),
    });

    const indexedLines = messages.filter((m) => m.startsWith('Indexed:'));
    expect(indexedLines).toHaveLength(2);
    expect(indexedLines[0]).toMatch(/^Indexed: a\.jpg \| album Trips \| Trips \| 2\.0 MB \| download \d+s, index \d+s, total \d+s \| #1$/);
    expect(indexedLines[1]).toContain('#2');
    const summary = messages.at(-1)!;
    expect(summary).toMatch(/^Summary: 2 indexed, 0 skipped, 0 failed \| [\d.]+ photos\/min overall, [\d.]+ last 2 \| 0 queued of 2 found, 1 folders listed \| elapsed /);
  });

  it('refuses a file over the staging limit before downloading it, and continues', async () => {
    const jpegBytes = await makeJpeg({ r: 11, g: 22, b: 33 });
    const driveClient = {
      list: vi.fn().mockResolvedValue({
        data: {
          files: [
            { id: 'huge', name: 'huge.jpg', mimeType: 'image/jpeg', size: String(300 * 1024 * 1024) },
            { id: 'ok', name: 'ok.jpg', mimeType: 'image/jpeg', size: '1234' },
          ],
        },
      }),
      get: vi.fn().mockImplementation(async () => ({ data: Readable.from([jpegBytes]) })),
    } as unknown as DriveFilesClient;
    const cloudflareClient = {
      checkHashes: vi.fn().mockResolvedValue(new Set()),
      uploadThumbnail: vi.fn().mockResolvedValue(undefined),
      ingestPhoto: vi.fn().mockResolvedValue(undefined),
    };
    const events: Array<{ file: string; outcome: string; reason?: string }> = [];

    const result = await indexGoogleDriveFolder(driveClient, 'folder-1', 'Kanha', {
      cloudflareClient: cloudflareClient as any,
      ollamaClient: { chat: vi.fn().mockResolvedValue(SAMPLE_RESPONSE) } as any,
      config: { ...config, DRIVE_STAGING_MAX_MB: 100 },
      tempDir: tempRoot,
      onFile: (e) => events.push(e),
    });

    expect(result).toEqual({ total: 2, indexed: 1, skipped: 0, failed: 1 });
    expect(driveClient.get).toHaveBeenCalledTimes(1); // the huge file was never downloaded
    expect(events[0]).toMatchObject({ file: 'huge.jpg', outcome: 'failed' });
    expect(events[0].reason).toContain('DRIVE_STAGING_MAX_MB');
    expect(await readdir(tempRoot)).toHaveLength(0);
  });

  it('sweeps stale downloads from a killed earlier run before indexing', async () => {
    const stale = path.join(tempRoot, 'pixdex-drive-orphan.jpg');
    await writeFile(stale, 'leftover');
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await utimes(stale, old, old);
    const messages: string[] = [];

    await indexGoogleDriveFolder(
      { list: vi.fn().mockResolvedValue({ data: { files: [] } }), get: vi.fn() } as unknown as DriveFilesClient,
      'folder-1',
      'Kanha',
      {
        cloudflareClient: { checkHashes: vi.fn() } as any,
        ollamaClient: {} as any,
        config,
        tempDir: tempRoot,
        onProgress: (m) => messages.push(m),
      }
    );

    expect(await readdir(tempRoot)).toHaveLength(0);
    expect(messages[0]).toContain('Removed 1 stale download');
  });

  it('starts indexing before the whole tree is listed, and survives a folder that cannot be listed', async () => {
    const [first, later] = await Promise.all([makeJpeg({ r: 31, g: 41, b: 59 }), makeJpeg({ r: 26, g: 53, b: 58 })]);
    const bytes: Record<string, Buffer> = { first, later };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const FOLDER = 'application/vnd.google-apps.folder';

    const driveClient = {
      list: vi.fn().mockImplementation(async ({ q }: { q: string }) => {
        const parent = /'([^']+)' in parents/.exec(q)![1];
        if (parent === 'locked') throw new Error('The caller does not have permission');
        if (parent === 'slow') {
          await gate; // listed only after the first photo has been indexed
          return { data: { files: [{ id: 'later', name: 'later.jpg', mimeType: 'image/jpeg' }] } };
        }
        return {
          data: {
            files: [
              { id: 'slow', name: 'Slow', mimeType: FOLDER },
              { id: 'locked', name: 'Locked', mimeType: FOLDER },
              { id: 'first', name: 'first.jpg', mimeType: 'image/jpeg' },
            ],
          },
        };
      }),
      get: vi.fn().mockImplementation(async ({ fileId }: { fileId: string }) => ({
        data: Readable.from([bytes[fileId]]),
      })),
    } as unknown as DriveFilesClient;
    const cloudflareClient = {
      checkHashes: vi.fn().mockResolvedValue(new Set()),
      uploadThumbnail: vi.fn().mockResolvedValue(undefined),
      // If listing were still done up front this would never run, and the test would time out.
      ingestPhoto: vi.fn().mockImplementation(async (p: { driveFileId: string }) => {
        if (p.driveFileId === 'first') release();
      }),
    };
    const messages: string[] = [];

    const result = await indexGoogleDriveFolder(driveClient, 'root', 'Trips', {
      cloudflareClient: cloudflareClient as any,
      ollamaClient: { chat: vi.fn().mockResolvedValue(SAMPLE_RESPONSE) } as any,
      config,
      tempDir: tempRoot,
      retry: { sleep: async () => {} },
      onProgress: (m) => messages.push(m),
    });

    expect(result).toEqual({ total: 2, indexed: 2, skipped: 0, failed: 1 }); // 1 failed = the locked folder
    expect(messages.some((m) => m.startsWith('Failed listing Trips / Locked'))).toBe(true);
    expect(messages.some((m) => m.startsWith('Listing finished: 3 folders'))).toBe(true);
  });

  it('puts photos from deep folders in the top-level folder album, so generic names never merge', async () => {
    const [x, y] = await Promise.all([makeJpeg({ r: 77, g: 1, b: 2 }), makeJpeg({ r: 3, g: 88, b: 4 })]);
    const FOLDER = 'application/vnd.google-apps.folder';
    const byParent: Record<string, unknown[]> = {
      root: [{ id: 'marriage', name: 'Arun Marriage', mimeType: FOLDER }, { id: 'eng', name: 'Engagement', mimeType: FOLDER }],
      marriage: [{ id: 'mp', name: 'Marriage Photos', mimeType: FOLDER }],
      mp: [{ id: 'mp001', name: '001', mimeType: FOLDER }],
      mp001: [{ id: 'x', name: 'x.jpg', mimeType: 'image/jpeg' }],
      eng: [{ id: 'eng001', name: '001', mimeType: FOLDER }],
      eng001: [{ id: 'y', name: 'y.jpg', mimeType: 'image/jpeg' }],
    };
    const bytes: Record<string, Buffer> = { x, y };
    const driveClient = {
      list: vi.fn().mockImplementation(async ({ q }: { q: string }) => ({
        data: { files: byParent[/'([^']+)' in parents/.exec(q)![1]] ?? [] },
      })),
      get: vi.fn().mockImplementation(async ({ fileId }: { fileId: string }) => ({ data: Readable.from([bytes[fileId]]) })),
    } as unknown as DriveFilesClient;
    const cloudflareClient = {
      checkHashes: vi.fn().mockResolvedValue(new Set()),
      uploadThumbnail: vi.fn().mockResolvedValue(undefined),
      ingestPhoto: vi.fn().mockResolvedValue(undefined),
    };

    await indexGoogleDriveFolder(driveClient, 'root', 'Varun', {
      cloudflareClient: cloudflareClient as any,
      ollamaClient: { chat: vi.fn().mockResolvedValue(SAMPLE_RESPONSE) } as any,
      config,
      tempDir: tempRoot,
    });

    const albums = Object.fromEntries(cloudflareClient.ingestPhoto.mock.calls.map(([p]) => [p.driveFileId, p.album]));
    expect(albums).toEqual({ x: 'Arun Marriage', y: 'Engagement' }); // not both '001'
  });

  it('skips a second copy of the same bytes within one run', async () => {
    const jpegBytes = await makeJpeg({ r: 70, g: 80, b: 90 });
    const driveClient = {
      list: vi.fn().mockResolvedValue({
        data: {
          files: [
            { id: 'one', name: 'one.jpg', mimeType: 'image/jpeg' },
            { id: 'two', name: 'copy of one.jpg', mimeType: 'image/jpeg' },
          ],
        },
      }),
      get: vi.fn().mockImplementation(async () => ({ data: Readable.from([jpegBytes]) })),
    } as unknown as DriveFilesClient;
    const cloudflareClient = {
      checkHashes: vi.fn().mockResolvedValue(new Set()),
      uploadThumbnail: vi.fn().mockResolvedValue(undefined),
      ingestPhoto: vi.fn().mockResolvedValue(undefined),
    };

    const result = await indexGoogleDriveFolder(driveClient, 'folder-1', 'Kanha', {
      cloudflareClient: cloudflareClient as any,
      ollamaClient: { chat: vi.fn().mockResolvedValue(SAMPLE_RESPONSE) } as any,
      config,
      tempDir: tempRoot,
    });

    expect(result).toEqual({ total: 2, indexed: 1, skipped: 1, failed: 0 });
    expect(cloudflareClient.ingestPhoto).toHaveBeenCalledTimes(1);
  });
});
