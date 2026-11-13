import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  downloadDriveFile,
  getDriveFolder,
  listDriveFolders,
  parseDriveFolderRef,
  withDriveRetry,
  type DriveFilesClient,
} from '../src/google/driveFiles';
import { albumFromDrivePath, DriveScanner, isRawFile, listImagesInDriveFolder, scanDriveFolder } from '../src/google/driveScan';

const FOLDER = 'application/vnd.google-apps.folder';
const noSleep = { sleep: async () => {} };

describe('listDriveFolders', () => {
  it('searches by name and returns id/name pairs, escaping quotes in the query', async () => {
    const list = vi.fn().mockResolvedValue({ data: { files: [{ id: 'f1', name: 'Kanha 2026' }] } });
    const client: DriveFilesClient = { list, get: vi.fn() };

    const folders = await listDriveFolders(client, `O'Brien's Trip`);

    expect(folders).toEqual([{ id: 'f1', name: 'Kanha 2026' }]);
    expect(client.get).not.toHaveBeenCalled(); // no parents, no lookups
    const [params] = list.mock.calls[0];
    expect(params.q).toContain("mimeType='application/vnd.google-apps.folder'");
    expect(params.q).toContain("name contains 'O\\'Brien\\'s Trip'");
  });

  it('shows each folder\'s parent name (one lookup per distinct parent) so same-named folders can be told apart', async () => {
    const list = vi.fn().mockResolvedValue({
      data: {
        files: [
          { id: 'v1', name: 'Varun', parents: ['p1'] },
          { id: 'v2', name: 'Varun', parents: ['p2'] },
          { id: 'v3', name: 'Varun Trip', parents: ['p1'] },
        ],
      },
    });
    const get = vi.fn().mockImplementation(async ({ fileId }: { fileId: string }) =>
      fileId === 'p1' ? { data: { id: 'p1', name: 'photos' } } : Promise.reject(new Error('no access'))
    );

    const folders = await listDriveFolders({ list, get } as unknown as DriveFilesClient, 'Varun', noSleep);

    expect(folders).toEqual([
      { id: 'v1', name: 'Varun', parentName: 'photos' },
      { id: 'v2', name: 'Varun' }, // a failed lookup only loses the hint
      { id: 'v3', name: 'Varun Trip', parentName: 'photos' },
    ]);
    expect(get).toHaveBeenCalledTimes(2);
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

  const byParent: Record<string, unknown[]> = {
    root: [
      { id: 'day1', name: 'Day 1', mimeType: FOLDER },
      { id: 'day2', name: 'Day 2', mimeType: FOLDER },
      { id: 'r1', name: 'top.jpg', mimeType: 'image/jpeg' },
      { id: 'x', name: '._top.jpg', mimeType: 'image/jpeg' },
      { id: 'raw1', name: 'top.CR2', mimeType: 'image/x-canon-cr2' },
      { id: 'raw2', name: 'top.dng', mimeType: 'image/jpeg' },
    ],
    day1: [
      { id: 'proc', name: 'processed', mimeType: FOLDER },
      { id: 'rawdir', name: 'Raw', mimeType: FOLDER },
      { id: 'a1', name: 'a.jpg', mimeType: 'image/jpeg' },
    ],
    proc: [{ id: 'b1', name: 'b.jpg', mimeType: 'image/jpeg' }],
    rawdir: [{ id: 'never', name: 'never.jpg', mimeType: 'image/jpeg' }],
    day2: [
      { id: 'extras', name: 'Extras', mimeType: FOLDER },
      { id: 'c1', name: 'c.jpg', mimeType: 'image/jpeg' },
    ],
    extras: [{ id: 'd1', name: 'd.jpg', mimeType: 'image/jpeg' }],
  };
  const treeClient = () =>
    ({
      list: vi.fn().mockImplementation(async ({ q }: { q: string }) => {
        const parent = /'([^']+)' in parents/.exec(q)![1];
        return { data: { files: byParent[parent] ?? [] } };
      }),
      get: vi.fn(),
    }) as unknown as DriveFilesClient;

  it('uses only a Processed folder when one exists, otherwise the folder and its subfolders; ignores RAW and AppleDouble', async () => {
    const images = await listImagesInDriveFolder(treeClient(), 'root', { rootName: 'Trip' });

    expect(images.map((i) => [i.id, i.folderPath])).toEqual([
      ['r1', ['Trip']], // no Processed at the top level: its own photos count
      ['c1', ['Trip', 'Day 2']], // Day 2 has no Processed: its photos and subfolders count
      ['b1', ['Trip', 'Day 1', 'processed']], // Day 1 has one (any case): only it is used
      ['d1', ['Trip', 'Day 2', 'Extras']],
    ]);
  });

  it('reports per folder what was ignored, for the dry run', async () => {
    const scan = await scanDriveFolder(treeClient(), 'root', { rootName: 'Trip' });
    const byName = Object.fromEntries(scan.folders.map((f) => [f.path.join('/'), f]));

    expect(byName['Trip']).toMatchObject({ rawIgnored: 2, processedOnly: false, ignoredPhotos: 0 });
    expect(byName['Trip/Day 1']).toMatchObject({
      processedOnly: true,
      ignoredPhotos: 1,
      ignoredFolders: ['Raw'],
    });
    expect(byName['Trip/Day 1/Raw']).toBeUndefined(); // never visited
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

describe('DriveScanner', () => {
  const sub = (n: number) => ({ id: `s${n}`, name: `Sub ${n}`, mimeType: FOLDER });
  const img = (id: string) => ({ id, name: `${id}.jpg`, mimeType: 'image/jpeg' });

  it('asks for 1000 entries per page', async () => {
    const list = vi.fn().mockResolvedValue({ data: { files: [] } });
    await scanDriveFolder({ list, get: vi.fn() } as unknown as DriveFilesClient, 'root');
    expect(list.mock.calls[0][0].pageSize).toBe(1000);
  });

  it('never lists more folders at once than the concurrency limit, and still lists them all', async () => {
    let inFlight = 0;
    let peak = 0;
    const list = vi.fn().mockImplementation(async ({ q }: { q: string }) => {
      const parent = /'([^']+)' in parents/.exec(q)![1];
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { data: { files: parent === 'root' ? [1, 2, 3, 4, 5].map(sub) : [img(`${parent}-photo`)] } };
    });

    const scan = await scanDriveFolder({ list, get: vi.fn() } as unknown as DriveFilesClient, 'root', {
      concurrency: 2,
    });

    expect(peak).toBe(2);
    expect(scan.images).toHaveLength(5);
    expect(scan.folders).toHaveLength(6);
  });

  it('hands over a folder as soon as it is listed, before slower folders finish', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const list = vi.fn().mockImplementation(async ({ q }: { q: string }) => {
      const parent = /'([^']+)' in parents/.exec(q)![1];
      if (parent === 'slow') await gate;
      return {
        data: { files: parent === 'root' ? [sub(0), { id: 'slow', name: 'Slow', mimeType: FOLDER }, img('quick')] : [] },
      };
    });
    const scanner = new DriveScanner({ list, get: vi.fn() } as unknown as DriveFilesClient, 'root', { rootName: 'R' });

    const first = await scanner.next();
    expect(first?.images.map((i) => i.id)).toEqual(['quick']);
    expect(scanner.done).toBe(false); // 'slow' is still being listed
    release();
    while (await scanner.next()) {
      // drain the rest
    }
    expect(scanner.done).toBe(true);
  });

  it('reports a failing subfolder and keeps going; a failing root throws', async () => {
    const list = vi.fn().mockImplementation(async ({ q }: { q: string }) => {
      const parent = /'([^']+)' in parents/.exec(q)![1];
      if (parent === 'bad') throw new Error('The caller does not have permission');
      return { data: { files: parent === 'root' ? [{ id: 'bad', name: 'Locked', mimeType: FOLDER }, img('ok')] : [] } };
    });
    const client = { list, get: vi.fn() } as unknown as DriveFilesClient;

    const scan = await scanDriveFolder(client, 'root', { rootName: 'R', ...noSleep });

    expect(scan.images.map((i) => i.id)).toEqual(['ok']);
    expect(scan.folders.find((f) => f.path.join('/') === 'R/Locked')?.error).toContain('permission');

    const rootFails = { list: vi.fn().mockRejectedValue(new Error('File not found')), get: vi.fn() } as unknown as DriveFilesClient;
    await expect(scanDriveFolder(rootFails, 'root', noSleep)).rejects.toThrow('File not found');
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

describe('albumFromDrivePath', () => {
  it('is the first folder under the picked one, or the picked folder itself', () => {
    expect(albumFromDrivePath(['Varun'])).toBe('Varun');
    expect(albumFromDrivePath(['Varun', 'Diwali 2014'])).toBe('Diwali 2014');
    expect(albumFromDrivePath(['Varun', 'Arun Marriage', 'Marriage Photos', '001'])).toBe('Arun Marriage');
    expect(albumFromDrivePath(['Varun', 'Aganvee Santa', 'Processed', 'backup'])).toBe('Aganvee Santa');
  });
});

describe('skip list', () => {
  const folder = (id: string, name: string) => ({ id, name, mimeType: FOLDER });
  const img = (id: string) => ({ id, name: `${id}.jpg`, mimeType: 'image/jpeg' });
  const client = () =>
    ({
      list: vi.fn().mockImplementation(async ({ q }: { q: string }) => {
        const parent = /'([^']+)' in parents/.exec(q)![1];
        const byParent: Record<string, unknown[]> = {
          root: [
            folder('lr', 'Shoot Previews.lrdata'),
            folder('ae', 'Adobe After Effects Auto-Save'),
            folder('fo', '(Footage)'),
            folder('ame', 'Baby Slideshow_AME'),
            folder('aep', 'butterfly_jpg.aep'),
            folder('cf', 'moon.collagefactoryfree'),
            folder('res', 'AllResources'),
            folder('vid', 'video'),
            folder('keep', 'Garden'),
          ],
          lr: [img('lr1')], ae: [img('ae1')], fo: [img('fo1')], ame: [img('ame1')], aep: [img('aep1')],
          cf: [img('cf1')], res: [img('res1')], vid: [img('vid1')], keep: [img('keep1')],
        };
        return { data: { files: byParent[parent] ?? [] } };
      }),
      get: vi.fn(),
    }) as unknown as DriveFilesClient;

  it('skips app, project and template-asset folders by default', async () => {
    const scan = await scanDriveFolder(client(), 'root', { rootName: 'R' });
    expect(scan.images.map((i) => i.id).sort()).toEqual(['keep1', 'vid1']);
    expect(scan.folders.find((f) => f.path.length === 1)?.excludedFolders.sort()).toEqual([
      '(Footage)',
      'Adobe After Effects Auto-Save',
      'AllResources',
      'Baby Slideshow_AME',
      'Shoot Previews.lrdata',
      'butterfly_jpg.aep',
      'moon.collagefactoryfree',
    ]);
  });

  it('adds --exclude globs (case-insensitive, * wildcard) and never matches partially', async () => {
    const scan = await scanDriveFolder(client(), 'root', { rootName: 'R', exclude: ['VIDEO', 'gard*'] });
    expect(scan.images).toHaveLength(0);

    const partial = await scanDriveFolder(client(), 'root', { rootName: 'R', exclude: ['vid'] });
    expect(partial.images.map((i) => i.id)).toContain('vid1'); // 'vid' does not match 'video'
  });

  it('never skips a Processed folder', async () => {
    const list = vi.fn().mockImplementation(async ({ q }: { q: string }) => ({
      data: { files: /'root' in parents/.test(q) ? [folder('p', 'Processed')] : [img('p1')] },
    }));
    const scan = await scanDriveFolder({ list, get: vi.fn() } as unknown as DriveFilesClient, 'root', {
      exclude: ['*'],
    });
    expect(scan.images.map((i) => i.id)).toEqual(['p1']); // '*' matches every other folder, but not Processed
  });
});

describe('isRawFile', () => {
  it('recognises camera RAW by extension or Drive mime type, and nothing else', () => {
    for (const name of ['a.CR2', 'a.nef', 'a.ARW', 'a.dng', 'a.raf', 'a.orf', 'a.rw2']) {
      expect(isRawFile(name, 'application/octet-stream')).toBe(true);
    }
    expect(isRawFile('noext', 'image/x-canon-cr2')).toBe(true);
    expect(isRawFile('a.jpg', 'image/jpeg')).toBe(false);
    expect(isRawFile('a.heic', 'image/heic')).toBe(false);
    expect(isRawFile('a.png', 'image/png')).toBe(false);
    expect(isRawFile('raw.jpg', 'image/jpeg')).toBe(false);
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
