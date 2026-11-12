import fs from 'node:fs/promises';
import path from 'node:path';
import type { FaceSidecarClient } from '../../faces/sidecarClient';
import { candidateTitles, MAX_GROUP_FACES, MIN_DET_SCORE } from '../buildGallery';
import { decodeEmbedding, type KnownPerson } from '../gallery';
import { RateLimitedError, type WikimediaClient } from '../wikimedia';

/** Photos kept per person for the picker (the build stops earlier, at 15 faces). */
export const PICK_MAX_PHOTOS = 30;

export interface CandidateFace {
  /** Pixel box [x1, y1, x2, y2] in the stored image. */
  bbox: [number, number, number, number];
  detScore: number;
  embedding: Float32Array;
}

export interface CandidatePhoto {
  title: string;
  license: string;
  width: number;
  height: number;
  contentType: string;
  image: Buffer;
  faces: CandidateFace[];
}

export interface PersonCandidates {
  id: string;
  /** Face model of the sidecar that produced the embeddings. */
  model: string;
  photos: CandidatePhoto[];
}

export interface GatherDeps {
  wikimedia: WikimediaClient;
  sidecar: FaceSidecarClient;
  download: (url: string) => Promise<Buffer>;
  onProgress?: (m: string) => void;
}

export function sniffContentType(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return 'image/jpeg';
}

/**
 * Gathers candidates the way the build does (portrait plus category files, raster only, open licences only, the same
 * client and pacing), downloads each image, detects faces and keeps image, boxes and embeddings. Photos with no
 * usable face, or more than MAX_GROUP_FACES faces, are dropped. Wikimedia and sidecar failures propagate.
 */
export async function gatherCandidates(person: KnownPerson, deps: GatherDeps): Promise<PersonCandidates> {
  const { wikimedia, sidecar, download, onProgress } = deps;
  const model = await sidecar.model();
  const titles = await candidateTitles(person, wikimedia);
  const infos = wikimedia.fileInfos ? await wikimedia.fileInfos(titles) : undefined;
  const photos: CandidatePhoto[] = [];
  for (const title of titles) {
    if (photos.length >= PICK_MAX_PHOTOS) break;
    const info = infos ? infos.get(title) : await wikimedia.fileInfo(title);
    if (!info) continue;
    if (!wikimedia.isOpenLicense(info.license)) {
      onProgress?.(`  skip ${title}: license "${info.license}"`);
      continue;
    }
    let image: Buffer;
    try {
      image = await download(info.thumbUrl);
    } catch (err) {
      if (err instanceof RateLimitedError) throw err;
      onProgress?.(`  skip ${title}: download failed`);
      continue;
    }
    let detection;
    try {
      detection = await sidecar.detect(image);
    } catch (err) {
      await sidecar.model(); // a dead sidecar throws here and fails the person
      onProgress?.(`  skip ${title}: not detectable (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    if (detection.faces.length === 0 || detection.faces.length > MAX_GROUP_FACES) continue;
    const faces: CandidateFace[] = [];
    for (const f of detection.faces) {
      if (!(f.detScore >= MIN_DET_SCORE)) continue;
      try {
        faces.push({ bbox: f.bbox, detScore: f.detScore, embedding: decodeEmbedding(f.embedding) });
      } catch {
        // undecodable embedding: that face is not offered
      }
    }
    if (faces.length === 0) continue;
    photos.push({
      title,
      license: info.license,
      width: detection.width,
      height: detection.height,
      contentType: sniffContentType(image),
      image,
      faces,
    });
  }
  return { id: person.id, model, photos };
}

const QID = /^Q[1-9]\d{0,12}$/;
export const isQid = (id: unknown): id is string => typeof id === 'string' && QID.test(id);

function b64(v: Float32Array): string {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
}

/** On-disk cache: `<dir>/<Q-id>/<n>.img` plus `meta.json`, written last so a half-written person is simply absent. */
export async function saveCached(dir: string, c: PersonCandidates): Promise<void> {
  if (!isQid(c.id)) throw new Error('bad id');
  const d = path.join(dir, c.id);
  await fs.rm(d, { recursive: true, force: true });
  await fs.mkdir(d, { recursive: true });
  for (const [i, p] of c.photos.entries()) await fs.writeFile(path.join(d, `${i}.img`), p.image);
  const meta = {
    id: c.id,
    model: c.model,
    photos: c.photos.map((p) => ({
      title: p.title,
      license: p.license,
      width: p.width,
      height: p.height,
      contentType: p.contentType,
      faces: p.faces.map((f) => ({ bbox: f.bbox, detScore: f.detScore, embedding: b64(f.embedding) })),
    })),
  };
  const tmp = path.join(d, 'meta.json.tmp');
  await fs.writeFile(tmp, JSON.stringify(meta));
  await fs.rename(tmp, path.join(d, 'meta.json'));
}

export async function loadCached(dir: string, id: string): Promise<PersonCandidates | undefined> {
  if (!isQid(id)) return undefined;
  const d = path.join(dir, id);
  try {
    const meta = JSON.parse(await fs.readFile(path.join(d, 'meta.json'), 'utf8'));
    const photos: CandidatePhoto[] = [];
    for (const [i, p] of (meta.photos as any[]).entries()) {
      photos.push({
        title: String(p.title),
        license: String(p.license),
        width: Number(p.width),
        height: Number(p.height),
        contentType: String(p.contentType),
        image: await fs.readFile(path.join(d, `${i}.img`)),
        faces: (p.faces as any[]).map((f) => ({
          bbox: f.bbox as [number, number, number, number],
          detScore: Number(f.detScore),
          embedding: decodeEmbedding(f.embedding),
        })),
      });
    }
    return { id, model: String(meta.model), photos };
  } catch {
    return undefined; // missing or corrupt: crawl again
  }
}

export type StoreEntry =
  | { status: 'loading' }
  | { status: 'ready'; candidates: PersonCandidates }
  | { status: 'error'; message: string };

export interface CandidateStore {
  /** Starts (once) and returns the current state; never blocks on the crawl. */
  request(person: KnownPerson): StoreEntry;
  /** Drops a failed entry so the next request retries. */
  retry(id: string): void;
}

/**
 * Memoised, cache-backed candidate loading. All crawls run one at a time through a single chain (Wikimedia allows one
 * request in flight from us), so a prefetch of the next person never overlaps the current one.
 */
export function createCandidateStore(opts: {
  cacheDir: string;
  gather: (person: KnownPerson) => Promise<PersonCandidates>;
  onError?: (person: KnownPerson, err: unknown) => void;
}): CandidateStore {
  const entries = new Map<string, StoreEntry>();
  let chain: Promise<unknown> = Promise.resolve();
  return {
    request(person) {
      const have = entries.get(person.id);
      if (have) return have;
      const loading: StoreEntry = { status: 'loading' };
      entries.set(person.id, loading);
      chain = chain.then(async () => {
        try {
          let c = await loadCached(opts.cacheDir, person.id);
          if (!c) {
            c = await opts.gather(person);
            await saveCached(opts.cacheDir, c);
          }
          entries.set(person.id, { status: 'ready', candidates: c });
        } catch (err) {
          opts.onError?.(person, err);
          entries.set(person.id, { status: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      });
      return loading;
    },
    retry(id) {
      if (entries.get(id)?.status === 'error') entries.delete(id);
    },
  };
}
