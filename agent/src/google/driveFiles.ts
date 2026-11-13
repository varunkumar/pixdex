import { createWriteStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface DriveListParams {
  q: string;
  fields: string;
  pageToken?: string;
  pageSize?: number;
  /** Include shared drives and "shared with me" items. */
  corpora?: 'user' | 'allDrives';
  supportsAllDrives?: boolean;
  includeItemsFromAllDrives?: boolean;
}

export interface DriveFilesClient {
  list(params: DriveListParams): Promise<{
    data: {
      files: Array<{
        id?: string | null;
        name?: string | null;
        mimeType?: string | null;
        sha256Checksum?: string | null;
        size?: string | number | null;
      }>;
      nextPageToken?: string | null;
    };
  }>;
  get(
    params: { fileId: string; alt: 'media'; supportsAllDrives?: boolean },
    options: { responseType: 'stream' }
  ): Promise<{ data: Readable }>;
  get(params: {
    fileId: string;
    fields: string;
    supportsAllDrives?: boolean;
  }): Promise<{ data: { id?: string | null; name?: string | null; mimeType?: string | null } }>;
}

export interface DriveFolderRef {
  id: string;
  name: string;
}

export interface DriveImageRef {
  id: string;
  name: string;
  mimeType: string;
  /** Lowercase hex SHA-256 of the file bytes, when Drive reports one (binary files do). */
  sha256?: string;
  /** Size in bytes as reported by Drive, when known. */
  size?: number;
  /** Folder names from the indexed root (inclusive) down to the folder holding this file. */
  folderPath: string[];
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ECONNABORTED']);
const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

function isRetryable(error: unknown): boolean {
  const e = error as {
    code?: number | string;
    status?: number;
    response?: { status?: number; data?: { error?: { errors?: Array<{ reason?: string }> } } };
  };
  const status = e?.response?.status ?? e?.status ?? (typeof e?.code === 'number' ? e.code : undefined);
  if (status === 429 || (status !== undefined && status >= 500)) return true;
  if (status === 403) {
    const reasons = e.response?.data?.error?.errors ?? [];
    return reasons.some((r) => r.reason !== undefined && RATE_LIMIT_REASONS.has(r.reason));
  }
  return typeof e?.code === 'string' && NETWORK_CODES.has(e.code);
}

/** Retries transient Drive failures (429, rate-limit 403, 5xx, network resets) with exponential backoff. */
export async function withDriveRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { attempts = 5, baseDelayMs = 500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = options;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || !isRetryable(error)) throw error;
      await sleep(Math.min(baseDelayMs * 2 ** (attempt - 1), 30_000));
    }
  }
}

const ALL_DRIVES = { corpora: 'allDrives', supportsAllDrives: true, includeItemsFromAllDrives: true } as const;

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export async function listDriveFolders(
  client: DriveFilesClient,
  query: string,
  options: RetryOptions = {}
): Promise<DriveFolderRef[]> {
  const q = `mimeType='${FOLDER_MIME}' and trashed=false and name contains '${escapeDriveQueryValue(query)}'`;
  const response = await withDriveRetry(
    () => client.list({ q, fields: 'files(id,name)', pageSize: 50, ...ALL_DRIVES }),
    options
  );
  return (response.data.files ?? [])
    .filter((f): f is { id: string; name: string } => Boolean(f.id && f.name))
    .map((f) => ({ id: f.id, name: f.name }));
}

/**
 * Accepts a bare folder id or a Drive folder URL
 * (https://drive.google.com/drive/folders/<id>, optionally with /u/0 or ?usp=...).
 * Returns null when the input is neither.
 */
export function parseDriveFolderRef(input: string): string | null {
  const value = input.trim();
  const fromUrl = /\/folders\/([A-Za-z0-9_-]+)/.exec(value) ?? /[?&]id=([A-Za-z0-9_-]+)/.exec(value);
  if (fromUrl) return fromUrl[1];
  return /^[A-Za-z0-9_-]{10,}$/.test(value) ? value : null;
}

/** Looks up one folder by id (works for shared drives and "shared with me"). Throws when it is not a folder. */
export async function getDriveFolder(
  client: DriveFilesClient,
  folderId: string,
  options: RetryOptions = {}
): Promise<DriveFolderRef> {
  const response = await withDriveRetry(
    () => client.get({ fileId: folderId, fields: 'id,name,mimeType', supportsAllDrives: true }),
    options
  );
  const { id, name, mimeType } = response.data;
  if (!id || !name) throw new Error(`Drive folder ${folderId} not found`);
  if (mimeType !== FOLDER_MIME) throw new Error(`Drive item "${name}" (${folderId}) is not a folder`);
  return { id, name };
}

/**
 * Lists every image under a folder, descending into subfolders (breadth first), like the
 * local scanner does. Each image carries its folder path so the album can follow the same
 * rule as local files.
 */
export async function listImagesInDriveFolder(
  client: DriveFilesClient,
  folderId: string,
  options: RetryOptions & { rootName?: string } = {}
): Promise<DriveImageRef[]> {
  const images: DriveImageRef[] = [];
  const visited = new Set<string>([folderId]);
  const queue: Array<{ id: string; path: string[] }> = [{ id: folderId, path: [options.rootName ?? ''] }];

  for (let next = queue.shift(); next; next = queue.shift()) {
    const folder = next;
    let pageToken: string | undefined;
    do {
      const response = await withDriveRetry(
        () =>
          client.list({
            q: `'${folder.id}' in parents and (mimeType contains 'image/' or mimeType='${FOLDER_MIME}') and trashed=false`,
            fields: 'nextPageToken, files(id,name,mimeType,sha256Checksum,size)',
            pageToken,
            pageSize: 100,
            ...ALL_DRIVES,
          }),
        options
      );

      for (const file of response.data.files ?? []) {
        if (!file.id || !file.name || !file.mimeType) continue;
        if (file.mimeType === FOLDER_MIME) {
          if (!visited.has(file.id)) {
            visited.add(file.id);
            queue.push({ id: file.id, path: [...folder.path, file.name] });
          }
        } else if (!file.name.startsWith('._')) {
          const ref: DriveImageRef = {
            id: file.id,
            name: file.name,
            mimeType: file.mimeType,
            folderPath: folder.path,
          };
          if (file.sha256Checksum) ref.sha256 = file.sha256Checksum.toLowerCase();
          if (file.size !== undefined && file.size !== null && Number.isFinite(Number(file.size))) {
            ref.size = Number(file.size); // the Drive API returns int64 as a string
          }
          images.push(ref);
        }
      }

      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);
  }

  return images;
}

export async function downloadDriveFile(
  client: DriveFilesClient,
  fileId: string,
  destPath: string,
  options: RetryOptions = {}
): Promise<void> {
  await withDriveRetry(async () => {
    const response = await client.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' }
    );
    // A retry reopens destPath, which truncates any partial bytes from the failed attempt.
    await pipeline(response.data, createWriteStream(destPath));
  }, options);
}
