import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Prefix of every file the Drive indexer downloads; the sweep only ever touches names with it. */
export const STAGING_PREFIX = 'pixdex-drive-';
export const DEFAULT_STAGING_MAX_BYTES = 1024 * 1024 * 1024;
const STALE_AFTER_MS = 60 * 60 * 1000;

/** A dedicated folder, so a leftover from a killed run is findable and the sweep never walks the whole temp dir. */
export function defaultStagingDir(): string {
  return path.join(tmpdir(), 'pixdex-drive-staging');
}

export function stagingLimitBytes(maxMb: number | undefined): number {
  return maxMb && maxMb > 0 ? Math.floor(maxMb * 1024 * 1024) : DEFAULT_STAGING_MAX_BYTES;
}

/**
 * Deletes downloads left behind by a run that was killed mid-photo (Ctrl-C, crash, power loss).
 * Only `pixdex-drive-*` files older than an hour are removed, so a second run in progress is safe.
 * Best effort: nothing here may stop indexing.
 */
export async function sweepStaleStaging(
  dir: string,
  options: { maxAgeMs?: number; now?: number } = {}
): Promise<{ removed: number; bytes: number }> {
  const { maxAgeMs = STALE_AFTER_MS, now = Date.now() } = options;
  let removed = 0;
  let bytes = 0;
  let names: string[];
  try {
    await mkdir(dir, { recursive: true });
    names = await readdir(dir);
  } catch {
    return { removed, bytes };
  }
  for (const name of names) {
    if (!name.startsWith(STAGING_PREFIX)) continue;
    const file = path.join(dir, name);
    try {
      const info = await stat(file);
      if (!info.isFile() || now - info.mtimeMs < maxAgeMs) continue;
      await rm(file, { force: true });
      removed++;
      bytes += info.size;
    } catch {
      // ignore: another process may have removed it, or it is locked
    }
  }
  return { removed, bytes };
}
