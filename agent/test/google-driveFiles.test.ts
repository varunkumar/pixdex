import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  downloadDriveFile,
  getDriveFolder,
  listDriveFolders,
  listImagesInDriveFolder,
  parseDriveFolderRef,
  withDriveRetry,
  type DriveFilesClient,
} from '../src/google/driveFiles';

const FOLDER = 'application/vnd.google-apps.folder';
const noSleep = { sleep: async () => {} };

describe('listDriveFolders', () => {
  it('searches by name and returns id/name pairs, escaping quotes in the query', async () => {
    const list = vi.fn().mockResolvedValue({ data: { files: [{ id: 'f1', name: 'Kanha 2026' }] } });
    const client: DriveFilesClient = { list, get: vi.fn() };

    const folders = await listDriveFolders(client, `O'Brien's Trip`);

    expect(folders).toEqual([{ id: 'f1', name: 'Kanha 2026' }]);
    const [params] = list.mock.calls[0];
    expect(params.q).toContain("mimeType='application/vnd.google-apps.folder'");
    expect(params.q).toContain("name contains 'O\\'Brien\\'s Trip'");
  });

  it('searches shared drives and shared-with-me folders too', async () => {
    const list = vi.fn().mockResolvedValue({ data: { files: [] } });
    await listDriveFolders({ list, get: vi.fn() }, 'x');
    expect(list.mock.calls[0][0]).toMatchObject({
      corpora: 'allDrives',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
  });
});

describe('listImagesInDriveFolder', () => {
  it('paginates through all pages and returns images with their folder path and checksum', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          files: [{ id: 'i1', name: 'a.jpg', mimeType: 'image/jpeg', sha256Checksum: 'ABC123' }],
          nextPageToken: 'page2',
        },
      })
      .mockResolvedValueOnce({
        data: { files: [{ id: 'i2', name: 'b.png', mimeType: 'image/png' }] },
      });
    const client: DriveFilesClient = { list, get: vi.fn() };

    const images = await listImagesInDriveFolder(client, 'folder-1', { rootName: 'Kanha' });

    expect(images).toEqual([
      { id: 'i1', name: 'a.jpg', mimeType: 'image/jpeg', sha256: 'abc123', folderPath: ['Kanha'] },
      { id: 'i2', name: 'b.png', mimeType: 'image/png', folderPath: ['Kanha'] },
    ]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1][0].pageToken).toBe('page2');
    expect(list.mock.calls[0][0].q).toContain("'folder-1' in parents");
    expect(list.mock.calls[0][0].q).toContain("mimeType contains 'image/'");
    expect(list.mock.calls[0][0].fields).toContain('sha256Checksum');
    expect(list.mock.calls[0][0]).toMatchObject({ supportsAllDrives: true, includeItemsFromAllDrives: true });
  });

  it('descends into subfolders, tracking the folder path, and ignores AppleDouble files', async () => {
    const byParent: Record<string, unknown[]> = {
      root: [
        { id: 'sub-a', name: 'Day 1', mimeType: FOLDER },
        { id: 'r1', name: 'top.jpg', mimeType: 'image/jpeg' },
        { id: 'x', name: '._top.jpg', mimeType: 'image/jpeg' },
      ],
      'sub-a': [
        { id: 'sub-b', name: 'Processed', mimeType: FOLDER },
        { id: 'a1', name: 'a.jpg', mimeType: 'image/jpeg' },
      ],
      'sub-b': [{ id: 'b1', name: 'b.jpg', mimeType: 'image/jpeg' }],
    };
    const list = vi.fn().mockImplementation(async ({ q }: { q: string }) => {
      const parent = /'([^']+)' in parents/.exec(q)![1];
      return { data: { files: byParent[parent] ?? [] } };
    });

    const images = await listImagesInDriveFolder({ list, get: vi.fn() }, 'root', { rootName: 'Trip' });

    expect(images.map((i) => [i.id, i.folderPath])).toEqual([
      ['r1', ['Trip']],
      ['a1', ['Trip', 'Day 1']],
      ['b1', ['Trip', 'Day 1', 'Processed']],
    ]);
  });

  it('does not loop when a folder is reachable twice', async () => {
    const list = vi.fn().mockImplementation(async ({ q }: { q: string }) => {
      const parent = /'([^']+)' in parents/.exec(q)![1];
      return { data: { files: parent === 'root' ? [{ id: 'root', name: 'again', mimeType: FOLDER }] : [] } };
    });
    await listImagesInDriveFolder({ list, get: vi.fn() }, 'root');
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('retries a rate-limited listing', async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce({ response: { status: 429 } })
      .mockResolvedValueOnce({ data: { files: [{ id: 'i1', name: 'a.jpg', mimeType: 'image/jpeg' }] } });

    const images = await listImagesInDriveFolder({ list, get: vi.fn() }, 'f', noSleep);

    expect(images).toHaveLength(1);
    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe('withDriveRetry', () => {
  it('retries 5xx, rate-limit 403 and network resets with growing delays, then gives up', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockRejectedValue({ code: 'ECONNRESET' });

    await expect(withDriveRetry(fn, { attempts: 4, baseDelayMs: 100, sleep })).rejects.toMatchObject({
      code: 'ECONNRESET',
    });
    expect(fn).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200, 400]);

    const flaky = vi
      .fn()
      .mockRejectedValueOnce({ code: 503 })
      .mockRejectedValueOnce({ response: { status: 403, data: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } } })
      .mockResolvedValueOnce('ok');
    await expect(withDriveRetry(flaky, noSleep)).resolves.toBe('ok');
  });

  it('does not retry permission, not-found or ordinary errors', async () => {
    for (const error of [
      { response: { status: 403, data: { error: { errors: [{ reason: 'forbidden' }] } } } },
      { response: { status: 404 } },
      new Error('boom'),
    ]) {
      const fn = vi.fn().mockRejectedValue(error);
      await expect(withDriveRetry(fn, noSleep)).rejects.toBe(error);
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });
});

describe('parseDriveFolderRef', () => {
  it('extracts an id from folder URLs and accepts a bare id', () => {
    expect(parseDriveFolderRef('https://drive.google.com/drive/folders/1AbC_dEf-GhIjKl?usp=sharing')).toBe('1AbC_dEf-GhIjKl');
    expect(parseDriveFolderRef('https://drive.google.com/drive/u/0/folders/1AbC_dEf-GhIjKl')).toBe('1AbC_dEf-GhIjKl');
    expect(parseDriveFolderRef('https://drive.google.com/open?id=1AbC_dEf-GhIjKl')).toBe('1AbC_dEf-GhIjKl');
    expect(parseDriveFolderRef('  1AbC_dEf-GhIjKl ')).toBe('1AbC_dEf-GhIjKl');
  });

  it('rejects anything else', () => {
    expect(parseDriveFolderRef('')).toBeNull();
    expect(parseDriveFolderRef('Kanha 2026')).toBeNull();
    expect(parseDriveFolderRef('short')).toBeNull();
  });
});

describe('getDriveFolder', () => {
  it('returns the folder and asks for shared-drive support', async () => {
    const get = vi.fn().mockResolvedValue({ data: { id: 'f1', name: 'Kanha', mimeType: FOLDER } });
    await expect(getDriveFolder({ list: vi.fn(), get } as unknown as DriveFilesClient, 'f1')).resolves.toEqual({
      id: 'f1',
      name: 'Kanha',
    });
    expect(get).toHaveBeenCalledWith({ fileId: 'f1', fields: 'id,name,mimeType', supportsAllDrives: true });
  });

  it('throws when the item is not a folder', async () => {
    const get = vi.fn().mockResolvedValue({ data: { id: 'f1', name: 'pic.jpg', mimeType: 'image/jpeg' } });
    await expect(getDriveFolder({ list: vi.fn(), get } as unknown as DriveFilesClient, 'f1')).rejects.toThrow(
      /not a folder/
    );
  });
});

describe('downloadDriveFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pixdex-drive-download-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('streams the file body to destPath', async () => {
    const get = vi.fn().mockResolvedValue({ data: Readable.from([Buffer.from('fake jpeg bytes')]) });
    const client = { list: vi.fn(), get } as unknown as DriveFilesClient;
    const destPath = path.join(dir, 'downloaded.jpg');

    await downloadDriveFile(client, 'file-1', destPath);

    expect(get).toHaveBeenCalledWith(
      { fileId: 'file-1', alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' }
    );
    expect((await readFile(destPath)).toString()).toBe('fake jpeg bytes');
  });

  it('retries a transient failure and keeps only the successful attempt bytes', async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValueOnce({ data: Readable.from([Buffer.from('complete')]) });
    const client = { list: vi.fn(), get } as unknown as DriveFilesClient;
    const destPath = path.join(dir, 'retry.jpg');

    await downloadDriveFile(client, 'file-1', destPath, noSleep);

    expect(get).toHaveBeenCalledTimes(2);
    expect((await readFile(destPath)).toString()).toBe('complete');
  });
});
