import type { DriveFilesClient, RetryOptions } from './driveFiles';
import { albumFromDrivePath, scanDriveFolder } from './driveScan';
import { stagingLimitBytes } from './staging';
import type { CloudflareClient } from '../cloudflareClient';
import type { AgentConfig } from '../config';

export interface DryRunFolderLine {
  /** Folder names from the picked root (inclusive). */
  path: string[];
  /** Photos in this folder that would be considered. */
  images: number;
  bytes: number;
  /** Already indexed, known from Drive's checksum (no download needed). */
  alreadyIndexed: number;
  /** Drive gave no checksum, so only a download can tell whether it is indexed. */
  unknown: number;
  /** Bigger than DRIVE_STAGING_MAX_MB, would be refused. */
  overLimit: number;
  /** Camera RAW files, ignored. */
  rawIgnored: number;
  /** A Processed subfolder exists, so only it is used here. */
  processedOnly: boolean;
  /** Photos directly in this folder, ignored because a Processed folder exists. */
  ignoredPhotos: number;
  /** Subfolders ignored because a Processed folder exists. */
  ignoredFolders: string[];
  /** Subfolders skipped by the skip list (built-in patterns plus --exclude). */
  excludedFolders: string[];
}

export interface DryRunResult {
  folders: DryRunFolderLine[];
  images: number;
  bytes: number;
  alreadyIndexed: number;
  unknown: number;
  overLimit: number;
  rawIgnored: number;
  ignoredPhotos: number;
  /** Photos that would be downloaded and indexed (not known to be indexed, not over the limit). */
  toIndex: number;
  /** Distinct albums the listed photos would go into. */
  albums: number;
  /** False when the Worker check failed or was not available: `alreadyIndexed` is then 0. */
  hashCheck: boolean;
}

/**
 * Lists what `index-drive` would do, without downloading, calling Ollama or writing anything.
 * The only Worker call is one read-only `check-hashes` per 500 advertised checksums.
 */
export async function dryRunDriveFolder(
  driveClient: DriveFilesClient,
  folderId: string,
  folderName: string,
  deps: {
    cloudflareClient?: Pick<CloudflareClient, 'checkHashes'>;
    config: AgentConfig;
    retry?: RetryOptions;
    onWarning?: (message: string) => void;
    /** Called while listing (at most every few seconds) so a big tree is not silent. */
    onProgress?: (message: string) => void;
    /** Extra folder-name globs to skip, on top of the built-in skip list. */
    exclude?: string[];
  }
): Promise<DryRunResult> {
  let lastLog = 0;
  const scan = await scanDriveFolder(driveClient, folderId, {
    ...deps.retry,
    rootName: folderName,
    exclude: deps.exclude,
    onProgress: (folders, photos) => {
      const now = Date.now();
      if (now - lastLog >= 3000) {
        lastLog = now;
        deps.onProgress?.(`Listing: ${folders} folders, ${photos} photos found so far`);
      }
    },
  });
  for (const f of scan.folders) {
    if (f.error) deps.onWarning?.(`Could not list ${f.path.join(' / ')} (${f.error}); it and its subfolders are missing below`);
  }
  const { images } = scan;
  const maxBytes = stagingLimitBytes(deps.config.DRIVE_STAGING_MAX_MB);

  const advertised = [...new Set(images.flatMap((i) => (i.sha256 ? [i.sha256] : [])))];
  let known = new Set<string>();
  let hashCheck = false;
  if (deps.cloudflareClient && advertised.length > 0) {
    try {
      known = await deps.cloudflareClient.checkHashes(advertised);
      hashCheck = true;
    } catch (error) {
      deps.onWarning?.(
        `Could not check which photos are already indexed (${error instanceof Error ? error.message : String(error)}); counts show everything as new`
      );
    }
  }

  const lines = new Map<string, DryRunFolderLine>();
  for (const f of scan.folders) {
    lines.set(f.path.join('\0'), {
      path: f.path,
      images: 0,
      bytes: 0,
      alreadyIndexed: 0,
      unknown: 0,
      overLimit: 0,
      rawIgnored: f.rawIgnored,
      processedOnly: f.processedOnly,
      ignoredPhotos: f.ignoredPhotos,
      ignoredFolders: f.ignoredFolders,
      excludedFolders: f.excludedFolders,
    });
  }

  const seen = new Set<string>();
  const totals = { alreadyIndexed: 0, unknown: 0, overLimit: 0, toIndex: 0, bytes: 0 };

  for (const image of images) {
    const line = lines.get(image.folderPath.join('\0'))!;
    line.images++;
    line.bytes += image.size ?? 0;
    totals.bytes += image.size ?? 0;

    if (image.sha256 && known.has(image.sha256)) {
      line.alreadyIndexed++;
      totals.alreadyIndexed++;
    } else if (image.size !== undefined && image.size > maxBytes) {
      line.overLimit++;
      totals.overLimit++;
    } else if (image.sha256 && seen.has(image.sha256)) {
      // a second copy of the same bytes in this run is skipped, like a real run
      line.alreadyIndexed++;
      totals.alreadyIndexed++;
    } else {
      if (image.sha256) {
        seen.add(image.sha256);
      } else {
        line.unknown++;
        totals.unknown++;
      }
      totals.toIndex++;
    }
  }

  const all = [...lines.values()];
  return {
    folders: all,
    images: images.length,
    bytes: totals.bytes,
    alreadyIndexed: totals.alreadyIndexed,
    unknown: totals.unknown,
    overLimit: totals.overLimit,
    rawIgnored: all.reduce((n, f) => n + f.rawIgnored, 0),
    ignoredPhotos: all.reduce((n, f) => n + f.ignoredPhotos, 0),
    toIndex: totals.toIndex,
    albums: new Set(all.filter((f) => f.images > 0).map((f) => albumFromDrivePath(f.path))).size,
    hashCheck,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function describe(line: DryRunFolderLine, hashCheck: boolean): string {
  const parts: string[] = [];
  if (line.images > 0) {
    parts.push(`${line.images} photos`, formatBytes(line.bytes));
    if (hashCheck) parts.push(`${line.alreadyIndexed} already indexed`);
    if (line.unknown > 0) parts.push(`${line.unknown} unchecked (no Drive checksum)`);
    if (line.overLimit > 0) parts.push(`${line.overLimit} over size limit`);
  }
  const notes: string[] = [];
  if (line.processedOnly) {
    const ignored = [
      line.ignoredPhotos > 0 ? `${line.ignoredPhotos} photos` : '',
      line.ignoredFolders.length > 0 ? `${line.ignoredFolders.length} other folders` : '',
    ].filter(Boolean);
    notes.push(`only Processed is used${ignored.length ? `, ignoring ${ignored.join(' and ')} outside it` : ''}`);
  }
  if (line.rawIgnored > 0) notes.push(`${line.rawIgnored} RAW ignored`);
  return [parts.join(', '), notes.length ? `[${notes.join('; ')}]` : ''].filter(Boolean).join('  ');
}

/**
 * Directory-listing style report: every folder visited as a tree, with what would be indexed in
 * each and what is ignored (RAW files, everything outside a Processed folder), then a total.
 */
export function formatDryRun(result: DryRunResult): string[] {
  const byPath = new Map(result.folders.map((f) => [f.path.join('\0'), f]));
  const children = new Map<string, string[][]>();
  for (const f of result.folders) {
    if (f.path.length < 2) continue;
    const parent = f.path.slice(0, -1).join('\0');
    children.set(parent, [...(children.get(parent) ?? []), f.path]);
  }

  const out: string[] = [];
  const render = (line: DryRunFolderLine, prefix: string, label: string) => {
    const text = describe(line, result.hashCheck);
    out.push(`${prefix}${label}/${text ? `  ${text}` : ''}`);
  };

  const walk = (line: DryRunFolderLine, indent: string) => {
    const kids = (children.get(line.path.join('\0')) ?? [])
      .slice()
      .sort((a, b) => a[a.length - 1].localeCompare(b[b.length - 1]));
    const ignored = line.ignoredFolders.slice().sort((a, b) => a.localeCompare(b));
    const entries: Array<{ name: string; path?: string[]; note?: string }> = [
      ...kids.map((p) => ({ name: p[p.length - 1], path: p })),
      ...ignored.map((name) => ({ name, note: 'ignored: a Processed folder exists next to it' })),
      ...line.excludedFolders.map((name) => ({ name, note: 'excluded: on the skip list' })),
    ].sort((a, b) => a.name.localeCompare(b.name));

    entries.forEach((entry, i) => {
      const last = i === entries.length - 1;
      const branch = last ? '└── ' : '├── ';
      const childIndent = indent + (last ? '    ' : '│   ');
      if (entry.path) {
        const child = byPath.get(entry.path.join('\0'))!;
        render(child, indent + branch, entry.name);
        walk(child, childIndent);
      } else {
        out.push(`${indent}${branch}${entry.name}/  [${entry.note}]`);
      }
    });
  };

  const root = result.folders[0];
  if (root) {
    render(root, '', root.path[0]);
    walk(root, '');
  }

  out.push(
    `Total: ${result.images} photos (${formatBytes(result.bytes)}) in ${result.folders.length} folder(s), ${result.albums} album(s)` +
      (result.hashCheck ? `, ${result.alreadyIndexed} already indexed` : '') +
      `, ${result.toIndex} would be indexed` +
      (result.overLimit > 0 ? `, ${result.overLimit} refused (over size limit)` : '') +
      (result.unknown > 0 ? `; ${result.unknown} of those could still turn out to be indexed (no checksum)` : '')
  );
  if (result.rawIgnored > 0 || result.ignoredPhotos > 0) {
    out.push(
      `Ignored: ${result.rawIgnored} RAW files, ${result.ignoredPhotos} photos outside Processed folders (in folders that have one)`
    );
  }
  if (!result.hashCheck) out.push('Already-indexed counts are unavailable (Worker check skipped or failed).');
  return out;
}
