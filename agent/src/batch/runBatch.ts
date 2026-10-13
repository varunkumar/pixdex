import fs from 'node:fs/promises';
import { acquireLock, loadState, MAX_RECORDED_FAILURES, saveState, type AlbumState } from './state';
import { discoverAlbums, type Discovery } from './discover';
import { mergeDiscovered, orderQueue } from './queue';
import type { IndexFileEvent, IndexLocalFolderResult } from '../indexLocalFolder';

export interface BatchDeps {
  indexFolder: (
    folder: string,
    hooks: { onFile: (event: IndexFileEvent) => void; onProgress: (message: string) => void }
  ) => Promise<IndexLocalFolderResult>;
  /** Returns a description of what is wrong (Ollama or the Worker unreachable), or null when fine. */
  checkHealth: () => Promise<string | null>;
  discover?: (inputs: string[]) => Promise<Discovery>;
  exists?: (dir: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface BatchOptions {
  inputs: string[];
  stateFile: string;
  lockFile: string;
  priority: RegExp[];
  retryFailed?: boolean;
  /** How long to wait between health / availability checks. */
  waitMs?: number;
  /** Consecutive crashes of one album before the run gives up (exit code 1). */
  maxConsecutiveErrors?: number;
}

export interface BatchResult {
  albumsProcessed: number;
  exitCode: number;
}

const defaultExists = async (dir: string) => {
  try {
    await fs.access(dir);
    return true;
  } catch {
    return false;
  }
};

export async function runBatch(options: BatchOptions, deps: BatchDeps): Promise<BatchResult> {
  const {
    discover = discoverAlbums,
    exists = defaultExists,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now = () => new Date(),
    log = () => {},
  } = deps;
  const waitMs = options.waitMs ?? 60_000;
  const maxErrors = options.maxConsecutiveErrors ?? 10;

  const lock = await acquireLock(options.lockFile);
  try {
    const loaded = await loadState(options.stateFile, now());
    const state = loaded.state;
    if (loaded.warning) log(loaded.warning);

    const discovery = await discover(options.inputs);
    discovery.unavailable.forEach((input) => log(`Not available right now (is the disk mounted?): ${input}`));
    const merged = mergeDiscovered(state, discovery.albums, { retryFailed: options.retryFailed });
    if (merged.added.length) log(`Queued ${merged.added.length} new album(s).`);
    if (merged.requeued.length) log(`Re-queued ${merged.requeued.length} album(s): ${merged.requeued.join(', ')}`);

    // One serialized writer so per-photo updates never interleave on disk.
    let writing: Promise<void> = Promise.resolve();
    const persist = () => {
      writing = writing.then(() => saveState(options.stateFile, state, now()));
      return writing;
    };
    await persist();

    let processed = 0;
    let consecutiveErrors = 0;
    const waitFor = async (probe: () => Promise<string | null>) => {
      for (let problem = await probe(); problem; problem = await probe()) {
        log(`Waiting: ${problem}`);
        await sleep(waitMs);
      }
    };

    for (;;) {
      const next = orderQueue(
        Object.values(state.albums).filter((a) => a.status === 'pending'),
        options.priority
      );
      let album: AlbumState | undefined;
      for (const candidate of next) {
        if (await exists(candidate.processedDir)) {
          album = candidate;
          break;
        }
        log(`Skipping for now (folder not available): ${candidate.processedDir}`);
      }
      if (!album) break;

      await waitFor(() => deps.checkHealth());

      album.status = 'running';
      album.startedAt = now().toISOString();
      album.completedAt = undefined;
      album.lastError = undefined;
      album.indexed = album.skipped = album.failed = 0;
      album.failures = [];
      await persist();
      log(`Indexing: ${album.name} (${album.imageCount} photos)`);

      // Time between consecutive analysed photos is the per-photo cost; the first
      // event of an album includes hashing, so it only starts the clock.
      let lastEventAt: number | null = null;
      const onFile = (event: IndexFileEvent) => {
        const at = now().getTime();
        if (event.outcome === 'indexed') {
          album!.indexed++;
          if (lastEventAt !== null) {
            state.stats.processingMs += at - lastEventAt;
            state.stats.processedPhotos++;
          }
        } else if (event.outcome === 'skipped') {
          album!.skipped++;
        } else {
          album!.failed++;
          if (album!.failures.length < MAX_RECORDED_FAILURES) {
            album!.failures.push({ file: event.file, reason: event.reason ?? 'unknown error' });
          }
        }
        lastEventAt = at;
        void persist();
      };

      try {
        await deps.indexFolder(album.processedDir, { onFile, onProgress: (m) => log(m) });
        await writing;
      } catch (error) {
        await writing;
        album.status = 'pending';
        album.lastError = error instanceof Error ? error.message : String(error);
        await persist();
        consecutiveErrors++;
        log(`Error on ${album.name}: ${album.lastError}`);
        if (consecutiveErrors >= maxErrors) return { albumsProcessed: processed, exitCode: 1 };
        await sleep(waitMs);
        continue;
      }
      consecutiveErrors = 0;

      // A disk that vanished or a model that went down makes every photo fail;
      // that is not a result, so the album goes back in the queue.
      const outage = !(await exists(album.processedDir)) ? 'folder became unavailable' : await deps.checkHealth();
      if (outage && album.failed > 0) {
        album.status = 'pending';
        album.lastError = outage;
        await persist();
        log(`Interrupted ${album.name}: ${outage}`);
        continue;
      }

      album.status = album.failed === 0 ? 'completed' : 'completed_with_failures';
      album.completedAt = now().toISOString();
      await persist();
      processed++;
      log(
        `Finished: ${album.name} (indexed ${album.indexed}, skipped ${album.skipped}, failed ${album.failed})`
      );
    }

    const left = Object.values(state.albums).filter((a) => a.status === 'pending').length;
    log(left === 0 ? 'Nothing left to index.' : `${left} album(s) still pending (folder not available).`);
    return { albumsProcessed: processed, exitCode: 0 };
  } finally {
    await lock.release();
  }
}
