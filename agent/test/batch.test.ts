import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverAlbums } from '../src/batch/discover';
import { mergeDiscovered, orderQueue } from '../src/batch/queue';
import { runBatch, type BatchDeps } from '../src/batch/runBatch';
import { acquireLock, emptyState, loadState, saveState, type BatchState } from '../src/batch/state';
import { formatStatus, summarize } from '../src/batch/status';
import type { IndexFileEvent } from '../src/indexLocalFolder';

let root: string;

async function makeAlbum(name: string, photos: number, processed = 'Processed') {
  const dir = path.join(root, name, processed);
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < photos; i++) await writeFile(path.join(dir, `p${i}.jpg`), `${name}-${i}`);
  return dir;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'pixdex-batch-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('discoverAlbums', () => {
  it('finds <root>/<album>/Processed, skips Unprocessed and albums without Processed', async () => {
    await makeAlbum('Kanha', 3);
    await makeAlbum('Lowercase', 2, 'processed');
    await makeAlbum('Unprocessed', 5, 'Processed'); // never touched
    await mkdir(path.join(root, 'NoProcessed', 'RAW'), { recursive: true });
    await writeFile(path.join(root, 'Kanha', 'Processed', 'notes.txt'), 'x');

    const { albums, unavailable } = await discoverAlbums([root]);

    expect(albums.map((a) => [a.name, a.imageCount])).toEqual([
      ['Kanha', 3],
      ['Lowercase', 2],
    ]);
    expect(unavailable).toEqual([]);
  });

  it('accepts a single album folder and reports unreadable inputs', async () => {
    await makeAlbum('Solo', 1);
    const missing = path.join(root, 'not-mounted');

    const { albums, unavailable } = await discoverAlbums([path.join(root, 'Solo'), missing]);

    expect(albums.map((a) => a.name)).toEqual(['Solo']);
    expect(unavailable).toEqual([missing]);
  });
});

describe('queue', () => {
  const album = (name: string, imageCount: number) => ({
    name,
    albumDir: `/x/${name}`,
    processedDir: `/x/${name}/Processed`,
    imageCount,
  });

  it('queues new albums, requeues finished ones whose count changed, and resets running', () => {
    const state = emptyState();
    mergeDiscovered(state, [album('A', 5), album('B', 5), album('C', 5)]);
    state.albums['/x/A/Processed'].status = 'completed';
    state.albums['/x/B/Processed'].status = 'completed';
    state.albums['/x/C/Processed'].status = 'running';

    const result = mergeDiscovered(state, [album('A', 5), album('B', 9), album('C', 5), album('D', 1)]);

    expect(result.added).toEqual(['D']);
    expect(result.requeued).toEqual(['B']);
    expect(state.albums['/x/A/Processed'].status).toBe('completed');
    expect(state.albums['/x/B/Processed'].status).toBe('pending');
    expect(state.albums['/x/C/Processed'].status).toBe('pending');
  });

  it('only retries albums with failures when asked', () => {
    const state = emptyState();
    mergeDiscovered(state, [album('F', 2)]);
    state.albums['/x/F/Processed'].status = 'completed_with_failures';

    mergeDiscovered(state, [album('F', 2)]);
    expect(state.albums['/x/F/Processed'].status).toBe('completed_with_failures');

    mergeDiscovered(state, [album('F', 2)], { retryFailed: true });
    expect(state.albums['/x/F/Processed'].status).toBe('pending');
  });

  it('orders priority matches first, then alphabetically', () => {
    const state = emptyState();
    mergeDiscovered(state, [album('Pongal', 1), album('Bandipur 2', 1), album('Aganvee', 1), album('Bandipur 1', 1)]);
    const ordered = orderQueue(Object.values(state.albums), [/bandipur/i]).map((a) => a.name);
    expect(ordered).toEqual(['Bandipur 1', 'Bandipur 2', 'Aganvee', 'Pongal']);
  });
});

describe('state file and lock', () => {
  it('round-trips and starts empty when missing', async () => {
    const file = path.join(root, 'state', 'queue.json');
    expect((await loadState(file)).state.albums).toEqual({});

    const state = emptyState();
    state.stats.processedPhotos = 3;
    await saveState(file, state);
    expect((await loadState(file)).state.stats.processedPhotos).toBe(3);
  });

  it('moves an unreadable file aside instead of crashing', async () => {
    const file = path.join(root, 'queue.json');
    await writeFile(file, '{ not json');
    const { state, warning } = await loadState(file);
    expect(state.albums).toEqual({});
    expect(warning).toMatch(/started fresh/);
  });

  it('refuses a second live run but takes over a stale lock', async () => {
    const file = path.join(root, 'batch.lock');
    const first = await acquireLock(file, process.pid);
    await expect(acquireLock(file, process.pid + 1)).rejects.toThrow(/already running/);
    await first.release();

    await writeFile(file, '999999'); // a pid that is not running
    const second = await acquireLock(file, process.pid);
    await second.release();
  });
});

describe('runBatch', () => {
  let stateFile: string;
  let lockFile: string;

  beforeEach(() => {
    stateFile = path.join(root, 'state', 'queue.json');
    lockFile = path.join(root, 'state', 'batch.lock');
  });

  const options = (extra: Partial<Parameters<typeof runBatch>[0]> = {}) => ({
    inputs: [root],
    stateFile,
    lockFile,
    priority: [],
    waitMs: 1,
    ...extra,
  });

  /** An indexer that "indexes" every file, optionally dying part way through one album. */
  function fakeIndexer(opts: { dieOn?: string; failFiles?: string[] } = {}): BatchDeps['indexFolder'] {
    return async (folder, hooks) => {
      const result = { total: 0, indexed: 0, skipped: 0, failed: 0 };
      const { readdir } = await import('node:fs/promises');
      for (const file of (await readdir(folder)).sort()) {
        if (opts.dieOn && folder.includes(opts.dieOn) && file === 'p1.jpg') throw new Error('machine restarted');
        result.total++;
        if (opts.failFiles?.includes(file)) {
          result.failed++;
          hooks.onFile({ file: path.join(folder, file), outcome: 'failed', reason: 'bad image' });
        } else {
          result.indexed++;
          hooks.onFile({ file: path.join(folder, file), outcome: 'indexed' });
        }
      }
      return result;
    };
  };

  const healthy = async () => null;

  it('indexes every album, records completion, and a second run has nothing to do', async () => {
    await makeAlbum('A', 3);
    await makeAlbum('B', 2);
    const indexFolder = vi.fn(fakeIndexer());

    const first = await runBatch(options(), { indexFolder, checkHealth: healthy });
    expect(first).toEqual({ albumsProcessed: 2, exitCode: 0 });

    const { state } = await loadState(stateFile);
    expect(Object.values(state.albums).map((a) => [a.name, a.status, a.indexed])).toEqual([
      ['A', 'completed', 3],
      ['B', 'completed', 2],
    ]);

    indexFolder.mockClear();
    const second = await runBatch(options(), { indexFolder, checkHealth: healthy });
    expect(second.albumsProcessed).toBe(0);
    expect(indexFolder).not.toHaveBeenCalled();
  });

  it('resumes after a crash: the interrupted album is retried, finished ones are not', async () => {
    await makeAlbum('A', 3);
    await makeAlbum('B', 3);

    // First process dies inside album B (after A finished).
    const crash = await runBatch(options({ maxConsecutiveErrors: 1 }), {
      indexFolder: fakeIndexer({ dieOn: `${path.sep}B${path.sep}` }),
      checkHealth: healthy,
    });
    expect(crash.exitCode).toBe(1);

    const mid = (await loadState(stateFile)).state;
    const byName = Object.fromEntries(Object.values(mid.albums).map((a) => [a.name, a]));
    expect(byName.A.status).toBe('completed');
    expect(byName.B.status).toBe('pending');
    expect(byName.B.lastError).toBe('machine restarted');

    // "Restart": a fresh run only touches B.
    const indexFolder = vi.fn(fakeIndexer());
    const resumed = await runBatch(options(), { indexFolder, checkHealth: healthy });
    expect(resumed).toEqual({ albumsProcessed: 1, exitCode: 0 });
    expect(indexFolder).toHaveBeenCalledTimes(1);
    expect(indexFolder.mock.calls[0][0]).toContain(`${path.sep}B${path.sep}`);
    expect(Object.values((await loadState(stateFile)).state.albums).every((a) => a.status === 'completed')).toBe(true);
  });

  it('treats a run killed mid-album (status running on disk) as pending on restart', async () => {
    const dir = await makeAlbum('A', 2);
    const state: BatchState = emptyState();
    state.albums[dir] = {
      name: 'A', albumDir: path.dirname(dir), processedDir: dir, status: 'running',
      imageCount: 2, indexed: 1, skipped: 0, failed: 0, failures: [],
    };
    await saveState(stateFile, state);

    const indexFolder = vi.fn(fakeIndexer());
    await runBatch(options(), { indexFolder, checkHealth: healthy });

    expect(indexFolder).toHaveBeenCalledTimes(1);
    expect((await loadState(stateFile)).state.albums[dir].status).toBe('completed');
  });

  it('records per-photo failures without losing the album', async () => {
    await makeAlbum('A', 3);
    await runBatch(options(), { indexFolder: fakeIndexer({ failFiles: ['p1.jpg'] }), checkHealth: healthy });

    const album = Object.values((await loadState(stateFile)).state.albums)[0];
    expect(album.status).toBe('completed_with_failures');
    expect(album.failed).toBe(1);
    expect(album.failures[0].reason).toBe('bad image');
  });

  it('waits for Ollama/Worker before starting an album', async () => {
    await makeAlbum('A', 1);
    const health = vi.fn().mockResolvedValueOnce('Ollama is not reachable').mockResolvedValue(null);
    const sleep = vi.fn(async () => {});
    const indexFolder = vi.fn(fakeIndexer());

    await runBatch(options(), { indexFolder, checkHealth: health, sleep });

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(indexFolder).toHaveBeenCalledTimes(1);
  });

  it('puts an album back in the queue when everything failed because of an outage', async () => {
    await makeAlbum('A', 2);
    // Healthy before the album, down after it (Ollama died mid-run).
    const health = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('Ollama is not reachable');
    let calls = 0;
    const indexFolder: BatchDeps['indexFolder'] = async (_folder, hooks) => {
      calls++;
      const failed = calls === 1;
      ['x', 'y'].forEach((f) =>
        hooks.onFile({ file: f, outcome: failed ? 'failed' : 'indexed', reason: 'fetch failed' } as IndexFileEvent)
      );
      return { total: 2, indexed: failed ? 0 : 2, skipped: 0, failed: failed ? 2 : 0 };
    };

    await runBatch(options(), { indexFolder, checkHealth: health.mockResolvedValue(null), sleep: async () => {} });

    expect(calls).toBe(2);
    expect(Object.values((await loadState(stateFile)).state.albums)[0].status).toBe('completed');
  });

  it('leaves albums on an unmounted disk pending and exits cleanly', async () => {
    await makeAlbum('A', 1);
    const dir = path.join(root, 'A', 'Processed');
    const state = emptyState();
    state.albums['/Volumes/Gone/B/Processed'] = {
      name: 'B', albumDir: '/Volumes/Gone/B', processedDir: '/Volumes/Gone/B/Processed',
      status: 'pending', imageCount: 4, indexed: 0, skipped: 0, failed: 0, failures: [],
    };
    await saveState(stateFile, state);

    const indexFolder = vi.fn(fakeIndexer());
    const result = await runBatch(options({ inputs: [root] }), { indexFolder, checkHealth: healthy });

    expect(result).toEqual({ albumsProcessed: 1, exitCode: 0 });
    const albums = (await loadState(stateFile)).state.albums;
    expect(albums[dir].status).toBe('completed');
    expect(albums['/Volumes/Gone/B/Processed'].status).toBe('pending');
  });

  it('writes progress to disk as photos complete', async () => {
    await makeAlbum('A', 3);
    const seen: number[] = [];
    const indexFolder: BatchDeps['indexFolder'] = async (folder, hooks) => {
      for (const f of ['p0.jpg', 'p1.jpg']) {
        hooks.onFile({ file: f, outcome: 'indexed' });
        // let the serialized write land, then read it back like `index-status` would
        await new Promise((r) => setTimeout(r, 20));
        seen.push((await loadState(stateFile)).state.albums[folder].indexed);
      }
      return { total: 3, indexed: 2, skipped: 0, failed: 0 };
    };

    await runBatch(options(), { indexFolder, checkHealth: healthy });
    expect(seen).toEqual([1, 2]);
  });
});

describe('status', () => {
  it('summarizes progress and lists albums by state', async () => {
    const state = emptyState();
    const add = (name: string, status: 'pending' | 'running' | 'completed', imageCount: number, indexed = 0) => {
      state.albums[`/x/${name}`] = {
        name, albumDir: `/x/${name}`, processedDir: `/x/${name}`, status, imageCount,
        indexed, skipped: 0, failed: 0, failures: [],
      };
    };
    add('Done', 'completed', 10, 10);
    add('Doing', 'running', 20, 5);
    add('Waiting', 'pending', 30);
    state.stats = { processingMs: 100_000, processedPhotos: 10 };

    const summary = summarize(state);
    expect(summary.photos).toMatchObject({ total: 60, done: 15 });
    expect(summary.albums).toMatchObject({ total: 3, completed: 1, running: 1, pending: 1 });
    expect(summary.avgSecondsPerPhoto).toBe(10);
    expect(summary.etaSeconds).toBe(450);

    const text = formatStatus(state);
    expect(text).toContain('Photos: 15 / 60 (25.0%)');
    expect(text).toContain('Running (1)');
    expect(text).toContain('5/20  Doing');
    expect(text).toContain('Waiting');
    expect(text).toContain('Completed (1)');
  });
});
