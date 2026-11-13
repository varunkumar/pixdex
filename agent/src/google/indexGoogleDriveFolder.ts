import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import mime from 'mime-types';
import { downloadDriveFile, type DriveFilesClient, type DriveImageRef, type RetryOptions } from './driveFiles';
import { albumFromDrivePath, DriveScanner, type DriveFolderResult } from './driveScan';
import { defaultStagingDir, stagingLimitBytes, sweepStaleStaging } from './staging';
import type { IndexFileEvent } from '../indexLocalFolder';
import { sha256ContentHash } from '../hashing';
import { processFile } from '../processFile';
import type { OllamaClient } from '../ollama/client';
import type { CloudflareClient } from '../cloudflareClient';
import type { AgentConfig } from '../config';
import type { Gallery } from '../known/gallery';
import type { FaceSidecarClient } from '../faces/sidecarClient';

/** Same cap as CloudflareClient.checkHashes: one request per 500 checksums. */
const CHECK_HASHES_BATCH = 500;
const LISTING_LOG_INTERVAL_MS = 5000;

export interface IndexGoogleDriveFolderResult {
  total: number;
  indexed: number;
  skipped: number;
  failed: number;
}

export interface IndexGoogleDriveFolderDeps {
  cloudflareClient: CloudflareClient;
  ollamaClient: OllamaClient;
  config: AgentConfig;
  faceSidecar?: FaceSidecarClient;
  knownGallery?: Gallery;
  onProgress?: (message: string) => void;
  /** Structured per-file outcome, for callers that track progress durably. */
  onFile?: (event: IndexFileEvent) => void;
  tempDir?: string;
  /** Retry tuning for Drive calls (tests inject a no-op sleep). */
  retry?: RetryOptions;
  /** Extra folder-name globs to skip, on top of the built-in skip list (see DEFAULT_EXCLUDED_FOLDERS). */
  exclude?: string[];
}

// A throwing `onProgress` callback must not abort the folder-indexing loop
// any more than a failed download/process/cleanup should. Swallow it.
function reportProgress(onProgress: ((message: string) => void) | undefined, message: string): void {
  try {
    onProgress?.(message);
  } catch {
    // ignore: progress reporting is best-effort
  }
}

export async function indexGoogleDriveFolder(
  driveClient: DriveFilesClient,
  folderId: string,
  folderName: string,
  deps: IndexGoogleDriveFolderDeps
): Promise<IndexGoogleDriveFolderResult> {
  const { cloudflareClient, ollamaClient, config, faceSidecar, knownGallery, onProgress, tempDir = defaultStagingDir(), retry } = deps;
  // Disk use is bounded: one photo is staged at a time and removed right after it is processed
  // (success, skip or failure), a photo bigger than the limit is refused before it is downloaded,
  // and leftovers from a killed earlier run are swept now.
  const maxBytes = stagingLimitBytes(config.DRIVE_STAGING_MAX_MB);
  const swept = await sweepStaleStaging(tempDir);
  if (swept.removed > 0) {
    reportProgress(onProgress, `Removed ${swept.removed} stale download(s) (${Math.round(swept.bytes / 1048576)} MB) from ${tempDir}`);
  }
  // Like progress reporting, a throwing structured callback must not abort the folder.
  const onFile = (event: IndexFileEvent) => {
    try {
      deps.onFile?.(event);
    } catch {
      // ignore
    }
  };

  let indexed = 0;
  let skipped = 0;
  let failed = 0;
  let total = 0;
  let foldersListed = 0;
  let lastListingLog = 0;
  let listingFinishedLogged = false;

  // Listing and indexing overlap: folders are listed a few at a time and each folder's photos are
  // queued as soon as it is listed, so the first photo starts after one list call instead of after
  // the whole tree. Indexing is the slow side (Ollama), so by the time a batch is done the queue
  // holds the next one.
  const scanner = new DriveScanner(driveClient, folderId, { ...retry, rootName: folderName, exclude: deps.exclude });
  const pending: DriveImageRef[] = [];
  const absorb = (result: DriveFolderResult) => {
    foldersListed++;
    total += result.images.length;
    pending.push(...result.images);
    if (result.scan.error) {
      failed++;
      const where = result.scan.path.join(' / ');
      reportProgress(onProgress, `Failed listing ${where} (${result.scan.error})`);
      onFile({ file: where, outcome: 'failed', reason: result.scan.error });
    }
  };
  // Called after a whole group of results has been absorbed: only then does `scanner.done` mean
  // "nothing is left", because `drain()` hands back a local array the scanner no longer tracks.
  const absorbAll = (results: DriveFolderResult[]) => {
    results.forEach(absorb);
    if (scanner.done) {
      if (!listingFinishedLogged) {
        listingFinishedLogged = true;
        reportProgress(onProgress, `Listing finished: ${foldersListed} folders, ${total} photos to consider`);
      }
    } else if (Date.now() - lastListingLog >= LISTING_LOG_INTERVAL_MS) {
      lastListingLog = Date.now();
      reportProgress(onProgress, `Listing: ${foldersListed} folders, ${total} photos found so far`);
    }
  };

  // Drive reports a SHA-256 for binary files, which is exactly our content hash. Already-indexed
  // photos are skipped without a download via check-hashes, one request per batch of up to 500
  // checksums (every photo that arrived while the previous batch was being indexed).
  const alreadyIndexed = new Set<string>();
  const checked = new Set<string>();
  const seenThisRun = new Set<string>();

  for (;;) {
    absorbAll(scanner.drain());
    if (pending.length === 0) {
      const result = await scanner.next();
      if (!result) break;
      absorbAll([result]);
      continue;
    }

    const batch = pending.splice(0, CHECK_HASHES_BATCH);
    const fresh = [...new Set(batch.flatMap((i) => (i.sha256 && !checked.has(i.sha256) ? [i.sha256] : [])))];
    if (fresh.length > 0) {
      for (const hash of await cloudflareClient.checkHashes(fresh)) alreadyIndexed.add(hash);
      fresh.forEach((hash) => checked.add(hash));
    }

    for (const image of batch) {
      // Keep absorbing folders as they finish while photos are being indexed (cheap, no waiting).
      absorbAll(scanner.drain());

      // Use only a random UUID (plus the original extension, for format
      // detection) in the temp filename. `image.name` is untrusted input from
      // Drive and may contain path-meaningful characters (e.g. "../"), so it
      // must never be interpolated directly into a filesystem path.
      // Drive names often lack an extension; fall back to the mime type so format detection works.
      const ext = path.extname(image.name) || (mime.extension(image.mimeType) ? `.${mime.extension(image.mimeType)}` : '');
      const tempPath = path.join(tempDir, `pixdex-drive-${randomUUID()}${ext}`);

      try {
        if (image.sha256 && alreadyIndexed.has(image.sha256)) {
          skipped++;
          reportProgress(onProgress, `Skipping already-indexed: ${image.name}`);
          onFile({ file: image.name, outcome: 'skipped' });
          continue;
        }

        if (image.size !== undefined && image.size > maxBytes) {
          throw new Error(`file is ${Math.round(image.size / 1048576)} MB, over the ${Math.round(maxBytes / 1048576)} MB staging limit (DRIVE_STAGING_MAX_MB)`);
        }
        await downloadDriveFile(driveClient, image.id, tempPath, retry);
        const downloaded = (await stat(tempPath)).size;
        if (downloaded > maxBytes) {
          throw new Error(`downloaded file is ${Math.round(downloaded / 1048576)} MB, over the ${Math.round(maxBytes / 1048576)} MB staging limit (DRIVE_STAGING_MAX_MB)`);
        }
        const contentHash = await sha256ContentHash(tempPath);

        if (seenThisRun.has(contentHash)) {
          skipped++;
          reportProgress(onProgress, `Skipping duplicate content in this run: ${image.name}`);
          onFile({ file: image.name, outcome: 'skipped' });
          continue;
        }
        // Without an advertised checksum the hash is only known after the download.
        const knownHashes = image.sha256 ? alreadyIndexed : await cloudflareClient.checkHashes([contentHash]);
        if (knownHashes.has(contentHash)) {
          skipped++;
          reportProgress(onProgress, `Skipping already-indexed: ${image.name}`);
          onFile({ file: image.name, outcome: 'skipped' });
          continue;
        }
        seenThisRun.add(contentHash);

        await processFile(
          {
            localPath: tempPath,
            contentHash,
            source: 'google_drive',
            driveFileId: image.id,
            filename: image.name,
            album: albumFromDrivePath(image.folderPath),
          },
          { cloudflareClient, ollamaClient, config, faceSidecar, knownGallery }
        );
        indexed++;
        reportProgress(onProgress, `Indexed: ${image.name}`);
        onFile({ file: image.name, outcome: 'indexed' });
      } catch (error) {
        failed++;
        const message = error instanceof Error ? error.message : String(error);
        reportProgress(onProgress, `Failed: ${image.name} (${message})`);
        onFile({ file: image.name, outcome: 'failed', reason: message });
      } finally {
        // Best-effort cleanup: a locked file, AV scanner, or read-only temp
        // dir can make `rm` reject even with `force: true` (which only
        // suppresses ENOENT). A cleanup failure must never abort the rest of
        // the folder, so it is swallowed here rather than propagated.
        try {
          await rm(tempPath, { force: true });
        } catch (cleanupError) {
          reportProgress(
            onProgress,
            `Cleanup failed for ${image.name} (${
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            })`
          );
        }
      }
    }
  }

  return { total, indexed, skipped, failed };
}
