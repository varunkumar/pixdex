import type { AlbumState, BatchState } from './state';

const done = (a: AlbumState) => a.indexed + a.skipped + a.failed;

export interface Summary {
  albums: { total: number; completed: number; running: number; pending: number; withFailures: number };
  photos: { total: number; done: number; failed: number; indexedThisTracker: number };
  avgSecondsPerPhoto: number | null;
  etaSeconds: number | null;
}

export function summarize(state: BatchState): Summary {
  const albums = Object.values(state.albums);
  const finished = albums.filter((a) => a.status === 'completed' || a.status === 'completed_with_failures');

  let total = 0;
  let doneCount = 0;
  let failed = 0;
  let remaining = 0;
  for (const album of albums) {
    total += album.imageCount;
    const isFinished = finished.includes(album);
    const complete = isFinished ? album.imageCount : Math.min(done(album), album.imageCount);
    doneCount += complete;
    failed += album.failed;
    remaining += album.imageCount - complete;
  }

  const { processingMs, processedPhotos } = state.stats;
  const avg = processedPhotos > 0 ? processingMs / processedPhotos / 1000 : null;

  return {
    albums: {
      total: albums.length,
      completed: finished.length,
      running: albums.filter((a) => a.status === 'running').length,
      pending: albums.filter((a) => a.status === 'pending').length,
      withFailures: albums.filter((a) => a.status === 'completed_with_failures').length,
    },
    photos: { total, done: doneCount, failed, indexedThisTracker: processedPhotos },
    avgSecondsPerPhoto: avg,
    // Remaining photos may already be indexed (skipped quickly), so this is an upper bound.
    etaSeconds: avg === null ? null : Math.round(remaining * avg),
  };
}

function duration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours >= 48) return `${(hours / 24).toFixed(1)} days`;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function bar(fraction: number, width = 20): string {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width);
  return `[${'#'.repeat(filled)}${'.'.repeat(width - filled)}]`;
}

export interface LiveCounts {
  /** Photos in the library right now (from the Worker). */
  total: number;
  /** Photos in the library per album name. */
  byAlbum: Record<string, number>;
}

export function formatStatus(state: BatchState, live?: LiveCounts): string {
  const summary = summarize(state);
  const albums = Object.values(state.albums);
  const lines: string[] = [];

  const pct = summary.photos.total ? (summary.photos.done / summary.photos.total) * 100 : 0;
  lines.push(
    `Photos: ${summary.photos.done.toLocaleString()} / ${summary.photos.total.toLocaleString()} (${pct.toFixed(1)}%)` +
      `   Albums: ${summary.albums.completed} / ${summary.albums.total} done` +
      (summary.albums.running ? `, ${summary.albums.running} running` : '') +
      `, ${summary.albums.pending} pending`
  );
  if (summary.avgSecondsPerPhoto !== null) {
    lines.push(
      `Speed: ${summary.avgSecondsPerPhoto.toFixed(0)}s per analysed photo` +
        (summary.etaSeconds !== null ? `   ETA: up to ${duration(summary.etaSeconds)}` : '')
    );
  }
  if (live) lines.push(`In the library now: ${live.total.toLocaleString()} photos (live, includes earlier runs)`);
  lines.push('Counts above are image files; identical copies are indexed once, so the library can be smaller.');
  if (summary.photos.failed > 0) lines.push(`Failed photos: ${summary.photos.failed}`);
  lines.push(`Updated: ${state.updatedAt}`);
  lines.push('');

  const section = (title: string, rows: AlbumState[], render: (a: AlbumState) => string) => {
    if (rows.length === 0) return;
    lines.push(`${title} (${rows.length})`);
    rows.forEach((row) => lines.push(`  ${render(row)}`));
    lines.push('');
  };

  section(
    'Running',
    albums.filter((a) => a.status === 'running'),
    (a) => `${bar(a.imageCount ? done(a) / a.imageCount : 0)} ${done(a)}/${a.imageCount}  ${a.name}`
  );
  section(
    'Pending',
    albums.filter((a) => a.status === 'pending'),
    (a) => {
      const already = live?.byAlbum[a.name] ?? 0;
      return (
        `${String(a.imageCount).padStart(5)}  ${a.name}` +
        (already > 0 ? `   (${already} already in library)` : '') +
        (a.lastError ? `   (last error: ${a.lastError})` : '')
      );
    }
  );
  section(
    'Completed with failures',
    albums.filter((a) => a.status === 'completed_with_failures'),
    (a) => `${a.name}: ${a.failed} failed of ${a.imageCount}` + a.failures.slice(0, 3).map((f) => `\n      ${f.file}: ${f.reason}`).join('')
  );
  section(
    'Completed',
    albums.filter((a) => a.status === 'completed').sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '')),
    (a) => `${String(a.imageCount).padStart(5)}  ${a.name}   ${a.completedAt ?? ''}`
  );

  return lines.join('\n').trimEnd();
}
