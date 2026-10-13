import fs from 'node:fs/promises';
import path from 'node:path';

export type AlbumStatus = 'pending' | 'running' | 'completed' | 'completed_with_failures';

export interface AlbumFailure {
  file: string;
  reason: string;
}

export interface AlbumState {
  name: string;
  albumDir: string;
  processedDir: string;
  status: AlbumStatus;
  /** Image files found in the processed folder when last discovered. */
  imageCount: number;
  /** Outcome counters for the current or most recent attempt. */
  indexed: number;
  skipped: number;
  failed: number;
  failures: AlbumFailure[];
  startedAt?: string;
  completedAt?: string;
  lastError?: string;
}

export interface BatchState {
  version: 1;
  createdAt: string;
  updatedAt: string;
  /** Wall time and photo count of photos actually analysed, for the ETA. */
  stats: { processingMs: number; processedPhotos: number };
  /** Keyed by processed-folder path. */
  albums: Record<string, AlbumState>;
}

export const MAX_RECORDED_FAILURES = 50;

export function emptyState(now: Date = new Date()): BatchState {
  const iso = now.toISOString();
  return { version: 1, createdAt: iso, updatedAt: iso, stats: { processingMs: 0, processedPhotos: 0 }, albums: {} };
}

export async function loadState(file: string, now: Date = new Date()): Promise<{ state: BatchState; warning?: string }> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: emptyState(now) };
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as BatchState;
    if (parsed.version !== 1 || typeof parsed.albums !== 'object') throw new Error('unexpected shape');
    return { state: parsed };
  } catch {
    // Indexing is idempotent (known photos are skipped by content hash), so
    // starting fresh is safe. Keep the unreadable file for inspection.
    const backup = `${file}.corrupt-${now.getTime()}`;
    await fs.rename(file, backup);
    return { state: emptyState(now), warning: `State file was unreadable; moved to ${backup} and started fresh.` };
  }
}

/** Atomic: write a temp file then rename, so a crash never leaves half a file. */
export async function saveState(file: string, state: BatchState, now: Date = new Date()): Promise<void> {
  state.updatedAt = now.toISOString();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, file);
}

export interface Lock {
  release(): Promise<void>;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** One batch run at a time: a PID file, taken over when its owner is gone. */
export async function acquireLock(file: string, pid: number = process.pid): Promise<Lock> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.writeFile(file, String(pid), { flag: 'wx' });
      return {
        release: async () => {
          await fs.rm(file, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = Number((await fs.readFile(file, 'utf8').catch(() => '')).trim());
      if (owner && owner !== pid && processIsAlive(owner)) {
        throw new Error(`Another index-batch is already running (pid ${owner}).`);
      }
      await fs.rm(file, { force: true });
    }
  }
  throw new Error('Could not acquire the batch lock.');
}
