import type { FaceSidecarClient } from '../faces/sidecarClient';
import { decodeEmbedding, type ExcludedPerson, type Gallery, type GalleryPerson, type KnownPerson } from './gallery';
import { API_REQUESTS_PER_PERSON, isRasterTitle, RateLimitedError, type WikimediaClient } from './wikimedia';

export const MAX_REFS = 10;
export const MIN_REFS = 3;
export const MIN_DET_SCORE = 0.6;
export const OUTLIER_COSINE = 0.35;
/**
 * Group photos (2 to MAX_GROUP_FACES faces) are used only after the single-face pass, with the accepted single-face
 * refs (the portrait counts) as anchors. A face is taken when its best cosine over the anchors is at least
 * GROUP_MIN_COSINE and it beats the next face in the same photo by GROUP_MARGIN. Max over anchors, not the mean
 * embedding: portraits vary in pose and age, and a mean blurs them; the margin guards against a lucky anchor.
 */
export const MAX_GROUP_FACES = 12;
export const GROUP_MIN_COSINE = 0.5;
export const GROUP_MARGIN = 0.1;
/** Group photos tried per person, so the build stays bounded. */
export const GROUP_PHOTO_LIMIT = 15;
/** Stop downloading once this many usable faces are in hand (headroom for outlier removal). */
const COLLECT_LIMIT = MAX_REFS + 5;
const CHECKPOINT_EVERY = 25;
/** Stop the build after this many people in a row fail on Wikimedia rate limiting. */
export const RATE_LIMIT_STOP_AFTER = 5;
const CATEGORY_DEPTH = 1;
const CATEGORY_LIMIT = 40;

export interface GalleryReport {
  included: { id: string; name: string; refs: number }[];
  excluded: { id: string; name: string; refs: number }[];
  /** Wikimedia errors: not stored, retried on the next run. */
  failed: { id: string; name: string; error: string }[];
  averageRefs: number;
  /** Refs (over included people) that came from group photos, picked by anchor matching. */
  groupRefs: number;
}

export interface BuildGalleryDeps {
  people: KnownPerson[];
  existing?: Gallery;
  rebuild?: string[];
  /** Re-crawl people recorded as excluded (too few references) instead of skipping them. */
  retryExcluded?: boolean;
  wikimedia: WikimediaClient;
  sidecar: FaceSidecarClient;
  download: (url: string) => Promise<Buffer>;
  onProgress?: (m: string) => void;
  onCheckpoint?: (gallery: Gallery) => Promise<void>;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Elementwise median of the refs, L2-normalised. */
export function medianReference(refs: Float32Array[]): Float32Array {
  const dim = refs[0].length;
  const out = new Float32Array(dim);
  const col = new Array<number>(refs.length);
  for (let d = 0; d < dim; d++) {
    for (let i = 0; i < refs.length; i++) col[i] = refs[i][d];
    col.sort((x, y) => x - y);
    const mid = col.length >> 1;
    out[d] = col.length % 2 ? col[mid] : (col[mid - 1] + col[mid]) / 2;
  }
  let sum = 0;
  for (let d = 0; d < dim; d++) sum += out[d] * out[d];
  const norm = Math.sqrt(sum) || 1;
  for (let d = 0; d < dim; d++) out[d] /= norm;
  return out;
}

/** The face sidecar itself is unreachable: the build must stop rather than exclude everyone. */
export class SidecarDownError extends Error {
  constructor(cause: unknown) {
    super(`Face sidecar is not reachable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'SidecarDownError';
  }
}

/** Wikimedia keeps rate limiting this machine: the build stops (after a checkpoint) instead of failing the whole list. */
export class RateLimitStopError extends Error {
  constructor() {
    super('Wikimedia is rate limiting this machine; wait a few minutes and rerun, finished people are kept');
    this.name = 'RateLimitStopError';
  }
}

interface GroupCandidate {
  title: string;
  faces: Float32Array[];
}

/** Picks the face that clearly matches the anchors; undefined when no face is confident enough. */
function pickGroupFace(faces: Float32Array[], anchors: Float32Array[]): { face: Float32Array; cosine: number } | undefined {
  let best = -Infinity;
  let second = -Infinity;
  let bestFace: Float32Array | undefined;
  for (const f of faces) {
    let c = -Infinity;
    for (const a of anchors) c = Math.max(c, dot(f, a));
    if (c > best) {
      second = best;
      best = c;
      bestFace = f;
    } else if (c > second) second = c;
  }
  if (!bestFace || best < GROUP_MIN_COSINE) return undefined;
  if (faces.length > 1 && best - second < GROUP_MARGIN) return undefined;
  return { face: bestFace, cosine: best };
}

/** Wikidata portrait plus Commons category files for the person, raster only, deduplicated. Wikimedia errors propagate. */
export async function candidateTitles(person: KnownPerson, wikimedia: WikimediaClient): Promise<string[]> {
  const candidates: string[] = [];
  const portrait = await wikimedia.portrait(person.id);
  if (portrait && isRasterTitle(portrait)) candidates.push(portrait);
  for (const title of await wikimedia.categoryFiles(person.id, { maxDepth: CATEGORY_DEPTH, limit: CATEGORY_LIMIT })) {
    if (isRasterTitle(title) && !candidates.includes(title)) candidates.push(title);
  }
  return candidates;
}

async function collectRefs(
  person: KnownPerson,
  deps: BuildGalleryDeps
): Promise<{ refs: Float32Array[]; groupRefs: number }> {
  const { wikimedia, sidecar, download, onProgress } = deps;
  // Wikimedia failures (including a persistent 429) propagate: the caller marks the person failed.
  const candidates = await candidateTitles(person, wikimedia);

  // One request for up to 50 titles; the loop below stops early once enough faces are in hand.
  const infos = wikimedia.fileInfos ? await wikimedia.fileInfos(candidates) : undefined;
  const refs: Float32Array[] = [];
  const groups: GroupCandidate[] = [];
  for (const title of candidates) {
    if (refs.length >= COLLECT_LIMIT) break;
    const info = infos ? infos.get(title) : await wikimedia.fileInfo(title);
    if (!info) {
      onProgress?.(`  skip ${title}: no thumbnail`);
      continue;
    }
    if (!wikimedia.isOpenLicense(info.license)) {
      onProgress?.(`  skip ${title}: license "${info.license}"`);
      continue;
    }
    let image: Buffer;
    try {
      image = await download(info.thumbUrl);
    } catch (err) {
      // A persistent 429 says nothing about the photo: fail the person (retried next run), do not skip or exclude.
      if (err instanceof RateLimitedError) throw err;
      onProgress?.(`  skip ${title}: download failed (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    let detection;
    try {
      detection = await sidecar.detect(image);
    } catch (err) {
      // A bad image can make the sidecar answer with an error; a dead sidecar cannot answer a health check.
      try {
        await sidecar.model();
      } catch (healthErr) {
        throw new SidecarDownError(healthErr);
      }
      onProgress?.(`  skip ${title}: not detectable (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    const count = detection.faces.length;
    if (count === 0 || count > MAX_GROUP_FACES) {
      onProgress?.(`  skip ${title}: ${count} faces`);
      continue;
    }
    if (count > 1) {
      // Decided after the single-face pass, once the anchors are known (no second download).
      const faces: Float32Array[] = [];
      try {
        for (const f of detection.faces) if (f.detScore >= MIN_DET_SCORE) faces.push(decodeEmbedding(f.embedding));
      } catch (err) {
        onProgress?.(`  skip ${title}: bad embedding (${err instanceof Error ? err.message : String(err)})`);
        continue;
      }
      if (faces.length === 0) onProgress?.(`  skip ${title}: low detection score`);
      else groups.push({ title, faces });
      continue;
    }
    const face = detection.faces[0];
    if (!(face.detScore >= MIN_DET_SCORE)) {
      onProgress?.(`  skip ${title}: low detection score`);
      continue;
    }
    try {
      refs.push(decodeEmbedding(face.embedding));
    } catch (err) {
      onProgress?.(`  skip ${title}: bad embedding (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  if (refs.length === 0) {
    if (groups.length > 0) onProgress?.(`  skip ${groups.length} group photos: no single-face anchor`);
    return { refs, groupRefs: 0 };
  }
  const median = medianReference(refs);
  const kept = refs.filter((r) => dot(r, median) >= OUTLIER_COSINE).slice(0, MAX_REFS);
  const anchors = kept.slice();
  let groupRefs = 0;
  let tried = 0;
  for (const group of groups) {
    if (kept.length >= MAX_REFS || tried >= GROUP_PHOTO_LIMIT || anchors.length === 0) break;
    tried++;
    const pick = pickGroupFace(group.faces, anchors);
    if (!pick || dot(pick.face, median) < OUTLIER_COSINE) {
      onProgress?.(`  skip ${group.title}: no confident face among ${group.faces.length}`);
      continue;
    }
    kept.push(pick.face);
    groupRefs++;
    onProgress?.(`  group ${group.title}: picked face (cos ${pick.cosine.toFixed(2)})`);
  }
  return { refs: kept, groupRefs };
}

/**
 * Builds (or incrementally updates) the known gallery. People already in `existing` (same model) keep
 * their refs unless listed in `rebuild`; people recorded as excluded (too few refs) are skipped unless listed in
 * `rebuild` or `retryExcluded` is set (the record keeps their ref count); people no longer in `people` are dropped. Images are downloaded
 * only to compute embeddings in memory; nothing but embeddings is kept.
 *
 * A Wikimedia failure marks only that person failed (listed in `report.failed`, never stored as a new
 * person, retried next run; a failed `rebuild` keeps the person's previous refs). A dead sidecar aborts
 * the build with SidecarDownError after a final checkpoint. `onCheckpoint` gets a consistent gallery
 * snapshot every CHECKPOINT_EVERY people and at the end.
 */
export async function buildGallery(deps: BuildGalleryDeps): Promise<{ gallery: Gallery; report: GalleryReport }> {
  const model = await deps.sidecar.model();
  const existing = deps.existing && deps.existing.model === model ? deps.existing : undefined;
  if (deps.existing && !existing) deps.onProgress?.(`Existing gallery is for model ${deps.existing.model}, rebuilding fully`);
  const kept = new Map(existing?.people.map((p) => [p.id, p]) ?? []);
  const keptExcluded = new Map((existing?.excluded ?? []).map((e) => [e.id, e]));
  const rebuild = new Set(deps.rebuild ?? []);
  const listed = new Set(deps.people.map((p) => p.id));
  for (const id of rebuild) if (!listed.has(id)) deps.onProgress?.(`Warning: --rebuild id ${id} is not in the people list`);

  const results = new Map<string, GalleryPerson | undefined>();
  const excludedNow = new Map<string, ExcludedPerson>();
  const report: GalleryReport = { included: [], excluded: [], failed: [], averageRefs: 0, groupRefs: 0 };

  /** Processed people use their new result; unprocessed ones keep their previous refs, so a partial save loses nothing. */
  const snapshot = (): Gallery => {
    const excluded = deps.people
      .map((p) => (results.has(p.id) ? excludedNow.get(p.id) : keptExcluded.get(p.id)))
      .filter((e): e is ExcludedPerson => e !== undefined);
    return {
      model,
      people: deps.people
        .map((p) => (results.has(p.id) ? results.get(p.id) : kept.get(p.id)))
        .filter((p): p is GalleryPerson => p !== undefined),
      ...(excluded.length > 0 ? { excluded } : {}),
    };
  };

  const crawl = deps.people.filter((p) => {
    if (kept.has(p.id) && !rebuild.has(p.id)) return false;
    return !(!kept.has(p.id) && keptExcluded.has(p.id) && !rebuild.has(p.id) && !deps.retryExcluded);
  });
  if (crawl.length > 0 && typeof deps.wikimedia.paceMs === 'number') {
    const requests = crawl.length * API_REQUESTS_PER_PERSON + Math.ceil(crawl.length / 50);
    const minutes = Math.ceil((requests * deps.wikimedia.paceMs) / 60_000);
    deps.onProgress?.(
      `Crawling ${crawl.length} people: about ${requests} Wikimedia API requests, at least ${minutes} min at the current pace (${(deps.wikimedia.paceMs / 1000).toFixed(1)} s between requests), plus image downloads`
    );
  }
  // Wikidata claims for everyone to crawl, 50 ids per request, before the per-person loop.
  await deps.wikimedia.prefetch?.(crawl.map((p) => p.id));
  let rateLimitedInARow = 0;
  for (const [index, person] of deps.people.entries()) {
    const prior = kept.get(person.id);
    const priorExcluded = keptExcluded.get(person.id);
    let refs: Float32Array[];
    let groupRefs = 0;
    if (prior && !rebuild.has(person.id)) {
      refs = prior.refs;
    } else if (!prior && priorExcluded && !rebuild.has(person.id) && !deps.retryExcluded) {
      // Already tried and too weak: do not crawl again (about 40 requests) unless asked.
      results.set(person.id, undefined);
      excludedNow.set(person.id, priorExcluded);
      report.excluded.push({ id: person.id, name: person.name, refs: priorExcluded.refs });
      continue;
    } else {
      deps.onProgress?.(`[${index + 1}/${deps.people.length}] ${person.name} (${person.id})`);
      try {
        ({ refs, groupRefs } = await collectRefs(person, deps));
      } catch (err) {
        if (err instanceof SidecarDownError) {
          await deps.onCheckpoint?.(snapshot());
          throw err;
        }
        rateLimitedInARow = err instanceof RateLimitedError ? rateLimitedInARow + 1 : 0;
        const message = err instanceof Error ? err.message : String(err);
        deps.onProgress?.(`  FAILED ${person.name} (${person.id}): ${message}`);
        report.failed.push({ id: person.id, name: person.name, error: message });
        if (prior) results.set(person.id, { ...prior, name: person.name, aliases: person.aliases });
        else {
          results.set(person.id, undefined);
          if (priorExcluded) excludedNow.set(person.id, priorExcluded);
        }
        if (rateLimitedInARow >= RATE_LIMIT_STOP_AFTER) {
          await deps.onCheckpoint?.(snapshot());
          throw new RateLimitStopError();
        }
        continue;
      }
      rateLimitedInARow = 0;
    }
    if (refs.length >= MIN_REFS) {
      const entry = { id: person.id, name: person.name, aliases: person.aliases, refs };
      results.set(person.id, entry);
      report.included.push({ id: person.id, name: person.name, refs: refs.length });
      report.groupRefs += groupRefs;
    } else {
      results.set(person.id, undefined);
      excludedNow.set(person.id, { id: person.id, refs: refs.length });
      report.excluded.push({ id: person.id, name: person.name, refs: refs.length });
    }
    if (deps.onCheckpoint && (index + 1) % CHECKPOINT_EVERY === 0) await deps.onCheckpoint(snapshot());
  }

  const gallery = snapshot();
  await deps.onCheckpoint?.(gallery);
  const total = report.included.reduce((sum, p) => sum + p.refs, 0);
  report.averageRefs = report.included.length ? total / report.included.length : 0;
  return { gallery, report };
}
