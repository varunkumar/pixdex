import fs from 'node:fs/promises';
import path from 'node:path';
import { scanDirectory } from './scanner';
import type { CloudflareClient } from './cloudflareClient';

export interface MoveAlbumOptions {
  /** Report what would happen without moving files or touching the index. */
  dryRun?: boolean;
  /** The folder was already moved by hand: only update the index. */
  indexOnly?: boolean;
  onProgress?: (message: string) => void;
}

export interface MoveAlbumResult {
  /** Indexed photos re-pointed (or that would be, on a dry run). */
  photos: number;
  /** Files moved on disk (0 for index-only and dry runs). */
  files: number;
  movedOnDisk: boolean;
}

const isDirectory = (p: string) =>
  fs.stat(p).then(
    (s) => s.isDirectory(),
    () => false
  );

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false
  );

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Copies the tree, then checks every file arrived with the same size before the source is removed. */
async function copyVerified(from: string, to: string): Promise<number> {
  const files = await scanDirectory(from);
  await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false });
  for (const file of files) {
    const relative = path.relative(from, file);
    const [a, b] = await Promise.all([fs.stat(file), fs.stat(path.join(to, relative)).catch(() => null)]);
    if (!b || a.size !== b.size) {
      throw new Error(`Copy verification failed for ${relative}; the source was left in place`);
    }
  }
  return files.length;
}

/**
 * Moves an album folder to a new location and re-points its indexed photos
 * (matched by path prefix) so thumbnails, metadata, owner edits and face data
 * all stay attached. Same-volume moves are a rename; across volumes the folder
 * is copied, verified file by file, then the source is removed.
 */
export async function moveAlbum(
  fromInput: string,
  toInput: string,
  deps: { cloudflareClient: CloudflareClient },
  options: MoveAlbumOptions = {}
): Promise<MoveAlbumResult> {
  const { cloudflareClient } = deps;
  const { dryRun = false, indexOnly = false, onProgress } = options;
  const from = path.resolve(fromInput);
  const to = path.resolve(toInput);

  if (from === to) throw new Error('Source and destination are the same folder');
  if (isInside(from, to) || isInside(to, from)) {
    throw new Error('Source and destination must not be inside one another');
  }
  if (indexOnly) {
    if (!(await isDirectory(to))) throw new Error(`Destination folder not found: ${to}`);
  } else {
    if (!(await isDirectory(from))) throw new Error(`Source folder not found: ${from}`);
    if (await exists(to)) throw new Error(`Destination already exists: ${to}`);
    if (!(await isDirectory(path.dirname(to)))) throw new Error(`Destination parent folder not found: ${path.dirname(to)}`);
  }

  const preview = await cloudflareClient.relocatePhotos(from, to, true);
  onProgress?.(`${preview.matched} indexed photo(s) under ${from}`);
  if (dryRun) {
    onProgress?.(indexOnly ? `Would re-point them to ${to}` : `Would move ${from} to ${to} and re-point them`);
    return { photos: preview.matched, files: 0, movedOnDisk: false };
  }

  let files = 0;
  if (!indexOnly) {
    try {
      await fs.rename(from, to);
      onProgress?.(`Renamed ${from} to ${to}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      onProgress?.('Different volume: copying and verifying, this can take a while');
      files = await copyVerified(from, to);
      await fs.rm(from, { recursive: true });
      onProgress?.(`Copied ${files} file(s) and removed ${from}`);
    }
  }

  try {
    const result = await cloudflareClient.relocatePhotos(from, to);
    onProgress?.(`Re-pointed ${result.updated} indexed photo(s)`);
    return { photos: result.updated, files, movedOnDisk: !indexOnly };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${reason}. The folder is already at ${to}; re-run with --index-only to finish updating the index`
    );
  }
}
