import type { DiscoveredAlbum } from './discover';
import type { AlbumState, BatchState } from './state';

export interface MergeResult {
  added: string[];
  requeued: string[];
}

/**
 * Brings a (possibly months-old) state file up to date with what is on disk:
 * new albums are queued; finished albums whose image count changed (more photos
 * were exported) are queued again. Nothing already tracked is dropped.
 */
export function mergeDiscovered(
  state: BatchState,
  discovered: DiscoveredAlbum[],
  options: { retryFailed?: boolean } = {}
): MergeResult {
  const result: MergeResult = { added: [], requeued: [] };

  for (const album of discovered) {
    const existing = state.albums[album.processedDir];
    if (!existing) {
      state.albums[album.processedDir] = {
        name: album.name,
        albumDir: album.albumDir,
        processedDir: album.processedDir,
        status: 'pending',
        imageCount: album.imageCount,
        indexed: 0,
        skipped: 0,
        failed: 0,
        failures: [],
      };
      result.added.push(album.name);
      continue;
    }

    const finished = existing.status === 'completed' || existing.status === 'completed_with_failures';
    const countChanged = existing.imageCount !== album.imageCount;
    existing.imageCount = album.imageCount;

    if (existing.status === 'running') {
      // The previous process died mid-album; idempotent indexing resumes it.
      existing.status = 'pending';
    } else if (finished && (countChanged || (options.retryFailed && existing.status === 'completed_with_failures'))) {
      existing.status = 'pending';
      result.requeued.push(album.name);
    }
  }

  return result;
}

/** Lower number runs first; ties keep alphabetical order. */
export function orderQueue(albums: AlbumState[], priority: RegExp[]): AlbumState[] {
  const rank = (name: string) => {
    const index = priority.findIndex((pattern) => pattern.test(name));
    return index === -1 ? priority.length : index;
  };
  return [...albums].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}
