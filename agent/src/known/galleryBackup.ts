import fs from 'node:fs/promises';
import path from 'node:path';
import { loadGallery, type Gallery } from './gallery';

/** The two R2 backup calls the agent needs (CloudflareClient implements them; tests inject fakes). */
export interface GalleryBackupClient {
  getKnownGallery(): Promise<Buffer | undefined>;
  putKnownGallery(bytes: Buffer | Uint8Array): Promise<void>;
}

/**
 * Tiny integrity check before upload: the bytes must be a JSON object with a model string and a people
 * array, so a corrupt local file can never overwrite a good backup. Embeddings are never printed.
 */
function assertGalleryShape(bytes: Buffer): void {
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('not valid JSON');
  }
  const g = json as { model?: unknown; people?: unknown } | null;
  if (!g || typeof g.model !== 'string' || !Array.isArray(g.people)) throw new Error('not a gallery file');
}

/** Pushes the saved gallery file to R2. Throws when the file is missing or malformed, or the upload fails. */
export async function pushGallery(client: GalleryBackupClient, file: string): Promise<number> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`no gallery file at ${file}`);
    throw err;
  }
  try {
    assertGalleryShape(bytes);
  } catch (err) {
    throw new Error(`refusing to push ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  await client.putKnownGallery(bytes);
  return bytes.byteLength;
}

/**
 * Downloads the R2 backup and, only if it passes the same loader as the local file, writes it to `file`.
 * Returns undefined when R2 has none, or (after a warning) when the object is corrupt. Other errors throw.
 */
export async function restoreFromR2(
  client: GalleryBackupClient,
  file: string,
  warn: (message: string) => void = (m) => console.warn(m)
): Promise<Gallery | undefined> {
  const bytes = await client.getKnownGallery();
  if (!bytes) return undefined;
  const temp = `${file}.restore.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(temp, bytes);
    assertGalleryShape(bytes);
    const gallery = await loadGallery(temp);
    if (!gallery) throw new Error('empty');
    await fs.rename(temp, file);
    return gallery;
  } catch (err) {
    warn(
      `The known gallery in R2 is unreadable (${err instanceof Error ? err.message : String(err)}); ignoring it. Rebuild with build-known-gallery --full, which replaces it.`
    );
    return undefined;
  } finally {
    await fs.rm(temp, { force: true });
  }
}

export type PullResult = { status: 'pulled'; gallery: Gallery } | { status: 'exists' } | { status: 'absent' };

/** `known-gallery-pull`: refuses to overwrite an existing local file unless `force`. */
export async function pullGallery(
  client: GalleryBackupClient,
  file: string,
  opts: { force: boolean; warn?: (message: string) => void }
): Promise<PullResult> {
  if (!opts.force) {
    const exists = await fs.access(file).then(
      () => true,
      () => false
    );
    if (exists) return { status: 'exists' };
  }
  const gallery = await restoreFromR2(client, file, opts.warn);
  return gallery ? { status: 'pulled', gallery } : { status: 'absent' };
}

/**
 * True when `after` differs from `before` in a way worth backing up: model, the people (ids, names, aliases,
 * and whether their references were recomputed: a kept person reuses the same refs array) or excluded records.
 */
export function galleryChanged(before: Gallery | undefined, after: Gallery): boolean {
  if (!before || before.model !== after.model) return true;
  if (before.people.length !== after.people.length) return true;
  for (let i = 0; i < after.people.length; i++) {
    const a = before.people[i];
    const b = after.people[i];
    if (a.id !== b.id || a.name !== b.name || a.refs !== b.refs) return true;
    if (a.aliases.length !== b.aliases.length || a.aliases.some((x, j) => x !== b.aliases[j])) return true;
  }
  const ex = (g: Gallery) => (g.excluded ?? []).map((e) => `${e.id}:${e.refs}`).join(',');
  return ex(before) !== ex(after);
}
