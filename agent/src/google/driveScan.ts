import {
  ALL_DRIVES,
  FOLDER_MIME,
  withDriveRetry,
  type DriveFilesClient,
  type DriveImageRef,
  type RetryOptions,
} from './driveFiles';

const RAW_EXTENSIONS = new Set([
  '.cr2', '.cr3', '.crw', '.nef', '.nrw', '.arw', '.srf', '.sr2', '.raf', '.orf', '.rw2', '.rwl', '.dng',
  '.pef', '.srw', '.raw', '.3fr', '.erf', '.kdc', '.dcr', '.mrw', '.x3f', '.iiq', '.mef', '.mos', '.cap',
]);
const RAW_MIME = /^image\/x-(canon|nikon|sony|fuji|olympus|panasonic|pentax|samsung|adobe-dng|leica|hasselblad|kodak|minolta|epson|sigma|phaseone|raw)/i;

/** Camera RAW files (CR2, NEF, ARW, DNG, ...) are never indexed, by extension or by Drive's mime type. */
export function isRawFile(name: string, mimeType: string): boolean {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
  return RAW_EXTENSIONS.has(ext) || RAW_MIME.test(mimeType);
}

function isProcessedFolder(name: string): boolean {
  return name.toLowerCase() === 'processed';
}

/**
 * Folders that hold application project files, caches or template assets, never photos worth
 * indexing (Lightroom previews, After Effects projects, collage-app resources). Case-insensitive
 * globs over a folder's own name, where `*` matches any run of characters.
 */
export const DEFAULT_EXCLUDED_FOLDERS = [
  '*.lrdata',
  '*.aep',
  'Adobe After Effects Auto-Save',
  '(Footage)',
  '*_AME',
  'allresources',
  '*.collagefactoryfree',
];

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * The album for a Drive photo: the first folder under the one that was picked, so a deep tree such as
 * `Arun Marriage / Marriage Photos / 001` is the album "Arun Marriage" and generic leaf names
 * ("001", "FB", "Upload") never merge unrelated folders. Photos directly in the picked folder use its name.
 */
export function albumFromDrivePath(folderPath: string[]): string {
  return folderPath[1] ?? folderPath[0];
}

/** What the scan did with one folder; the dry run prints these as a tree. */
export interface DriveFolderScan {
  /** Folder names from the indexed root (inclusive). */
  path: string[];
  /** RAW files in this folder, ignored. */
  rawIgnored: number;
  /** True when this folder has a Processed subfolder, so only that subfolder is used. */
  processedOnly: boolean;
  /** Photos directly in this folder that were ignored because a Processed folder exists. */
  ignoredPhotos: number;
  /** Sibling subfolders that were ignored because a Processed folder exists. */
  ignoredFolders: string[];
  /** Subfolders skipped because their name matches the skip list (defaults plus `exclude`). */
  excludedFolders: string[];
  /** Set when listing this folder failed (after retries); it and its subfolders were skipped. */
  error?: string;
}

export interface DriveFolderResult {
  scan: DriveFolderScan;
  /** The photos to index directly in this folder (empty when a Processed folder takes over, or on error). */
  images: DriveImageRef[];
}

export interface DriveScan {
  images: DriveImageRef[];
  folders: DriveFolderScan[];
}

export interface DriveScanOptions extends RetryOptions {
  rootName?: string;
  /** Folders listed at the same time (default 6). */
  concurrency?: number;
  /** Extra folder-name globs to skip, on top of DEFAULT_EXCLUDED_FOLDERS. */
  exclude?: string[];
}

/** files.list allows up to 1000 per page; the default is 100, ten times the requests for a big folder. */
const LIST_PAGE_SIZE = 1000;
const DEFAULT_CONCURRENCY = 6;

interface PendingFolder {
  id: string;
  path: string[];
  isRoot: boolean;
}

/**
 * Walks a Drive folder tree and hands over each folder's photos as soon as that folder is listed,
 * so indexing can start while the rest of the tree is still being listed. Folders are listed a few
 * at a time (`concurrency`); one list request per page of up to 1000 entries.
 *
 * Rules, per folder (they need that folder's whole listing, not the whole tree):
 * - if it has a `Processed` subfolder (any case), only that subfolder is used: the folder's own
 *   photos and its other subfolders are ignored; otherwise its own photos count and every
 *   subfolder is visited (and the rule applies again inside them);
 * - camera RAW files are always ignored.
 * A failing root throws; a failing subfolder is reported in its result (`scan.error`) and the walk goes on.
 */
export class DriveScanner {
  private ready: DriveFolderResult[] = [];
  private queue: PendingFolder[];
  private inFlight = 0;
  private visited: Set<string>;
  private waiter: (() => void) | undefined;
  private fatal: { error: unknown } | undefined;
  private readonly concurrency: number;
  private readonly excluded: RegExp[];

  constructor(
    private readonly client: DriveFilesClient,
    folderId: string,
    private readonly options: DriveScanOptions = {}
  ) {
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    this.excluded = [...DEFAULT_EXCLUDED_FOLDERS, ...(options.exclude ?? [])].map(globToRegExp);
    this.visited = new Set([folderId]);
    this.queue = [{ id: folderId, path: [options.rootName ?? ''], isRoot: true }];
    this.pump();
  }

  /** True once every folder has been listed and every result has been handed over. */
  get done(): boolean {
    return this.inFlight === 0 && this.queue.length === 0 && this.ready.length === 0;
  }

  /** Everything listed so far, without waiting. */
  drain(): DriveFolderResult[] {
    if (this.fatal) throw this.fatal.error;
    const out = this.ready;
    this.ready = [];
    return out;
  }

  /** The next listed folder, waiting for one if needed; null once the whole tree has been listed. */
  async next(): Promise<DriveFolderResult | null> {
    for (;;) {
      const result = this.ready.shift();
      if (result) return result;
      if (this.fatal) throw this.fatal.error;
      if (this.inFlight === 0 && this.queue.length === 0) return null;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }

  private pump(): void {
    while (this.inFlight < this.concurrency && this.queue.length > 0) {
      const folder = this.queue.shift()!;
      this.inFlight++;
      this.listFolder(folder)
        .then(
          ({ result, next }) => {
            this.ready.push(result);
            this.queue.push(...next);
          },
          (error: unknown) => {
            if (folder.isRoot) {
              this.fatal = { error };
            } else {
              this.ready.push({
                scan: {
                  path: folder.path,
                  rawIgnored: 0,
                  processedOnly: false,
                  ignoredPhotos: 0,
                  ignoredFolders: [],
                  excludedFolders: [],
                  error: error instanceof Error ? error.message : String(error),
                },
                images: [],
              });
            }
          }
        )
        .finally(() => {
          this.inFlight--;
          this.pump();
          const wake = this.waiter;
          this.waiter = undefined;
          wake?.();
        });
    }
  }

  private async listFolder(folder: PendingFolder): Promise<{ result: DriveFolderResult; next: PendingFolder[] }> {
    const direct: DriveImageRef[] = [];
    const subfolders: Array<{ id: string; name: string }> = [];
    const excludedFolders: string[] = [];
    let rawIgnored = 0;
    let pageToken: string | undefined;
    do {
      const response = await withDriveRetry(
        () =>
          this.client.list({
            q: `'${folder.id}' in parents and (mimeType contains 'image/' or mimeType='${FOLDER_MIME}') and trashed=false`,
            fields: 'nextPageToken, files(id,name,mimeType,sha256Checksum,size)',
            pageToken,
            pageSize: LIST_PAGE_SIZE,
            ...ALL_DRIVES,
          }),
        this.options
      );

      for (const file of response.data.files ?? []) {
        if (!file.id || !file.name || !file.mimeType) continue;
        if (file.mimeType === FOLDER_MIME) {
          if (!this.visited.has(file.id)) {
            this.visited.add(file.id);
            // A Processed folder is never skipped: a broad --exclude must not silently disable that rule.
            if (!isProcessedFolder(file.name) && this.excluded.some((re) => re.test(file.name!))) {
              excludedFolders.push(file.name);
            }
            else subfolders.push({ id: file.id, name: file.name });
          }
        } else if (isRawFile(file.name, file.mimeType)) {
          rawIgnored++;
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
          direct.push(ref);
        }
      }

      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);

    // The rule needs the whole folder listing (all pages), so it is applied here, after the loop.
    const processed = subfolders.filter((s) => isProcessedFolder(s.name));
    const processedOnly = processed.length > 0;
    const use = processedOnly ? processed : subfolders;
    return {
      result: {
        scan: {
          path: folder.path,
          rawIgnored,
          processedOnly,
          ignoredPhotos: processedOnly ? direct.length : 0,
          ignoredFolders: processedOnly
            ? subfolders.filter((s) => !isProcessedFolder(s.name)).map((s) => s.name)
            : [],
          // Not reported next to a Processed folder: those siblings are already ignored wholesale.
          excludedFolders: processedOnly ? [] : excludedFolders,
        },
        images: processedOnly ? [] : direct,
      },
      next: use.map((s) => ({ id: s.id, path: [...folder.path, s.name], isRoot: false })),
    };
  }
}

/** Lists the whole tree (used by the dry run), reporting progress as folders complete. */
export async function scanDriveFolder(
  client: DriveFilesClient,
  folderId: string,
  options: DriveScanOptions & { onProgress?: (folders: number, photos: number) => void } = {}
): Promise<DriveScan> {
  const scanner = new DriveScanner(client, folderId, options);
  const images: DriveImageRef[] = [];
  const folders: DriveFolderScan[] = [];
  for (let r = await scanner.next(); r; r = await scanner.next()) {
    images.push(...r.images);
    folders.push(r.scan);
    options.onProgress?.(folders.length, images.length);
  }
  return { images, folders };
}

export async function listImagesInDriveFolder(
  client: DriveFilesClient,
  folderId: string,
  options: DriveScanOptions = {}
): Promise<DriveImageRef[]> {
  return (await scanDriveFolder(client, folderId, options)).images;
}
