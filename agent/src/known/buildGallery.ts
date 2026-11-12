import type { FaceSidecarClient } from '../faces/sidecarClient';
import { decodeEmbedding, type ExcludedPerson, type Gallery, type GalleryPerson, type KnownPerson } from './gallery';
import type { WikimediaClient } from './wikimedia';

export const MAX_REFS = 10;
export const MIN_REFS = 3;
export const MIN_DET_SCORE = 0.6;
export const OUTLIER_COSINE = 0.35;
/** Stop downloading once this many usable faces are in hand (headroom for outlier removal). */
const COLLECT_LIMIT = MAX_REFS + 5;
const CHECKPOINT_EVERY = 25;
const CATEGORY_DEPTH = 1;
const CATEGORY_LIMIT = 40;

export interface GalleryReport {
  included: { id: string; name: string; refs: number }[];
  excluded: { id: string; name: string; refs: number }[];
  /** Wikimedia errors: not stored, retried on the next run. */
  failed: { id: string; name: string; error: string }[];
  averageRefs: number;
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

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Elementwise median of the refs, L2-normalised. */
function medianReference(refs: Float32Array[]): Float32Array {
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

async function collectRefs(person: KnownPerson, deps: BuildGalleryDeps): Promise<Float32Array[]> {
  const { wikimedia, sidecar, download, onProgress } = deps;
  // Wikimedia failures (including a persistent 429) propagate: the caller marks the person failed.
  const candidates: string[] = [];
  const portrait = await wikimedia.portrait(person.id);
  if (portrait) candidates.push(portrait);
  for (const title of await wikimedia.categoryFiles(person.id, { maxDepth: CATEGORY_DEPTH, limit: CATEGORY_LIMIT })) {
    if (!candidates.includes(title)) candidates.push(title);
  }

  const refs: Float32Array[] = [];
  for (const title of candidates) {
    if (refs.length >= COLLECT_LIMIT) break;
    const info = await wikimedia.fileInfo(title);
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
    if (detection.faces.length !== 1) {
      onProgress?.(`  skip ${title}: ${detection.faces.length} faces`);
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

  if (refs.length === 0) return refs;
  const median = medianReference(refs);
  return refs.filter((r) => dot(r, median) >= OUTLIER_COSINE).slice(0, MAX_REFS);
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
  const report: GalleryReport = { included: [], excluded: [], failed: [], averageRefs: 0 };

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

  for (const [index, person] of deps.people.entries()) {
    const prior = kept.get(person.id);
    const priorExcluded = keptExcluded.get(person.id);
    let refs: Float32Array[];
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
        refs = await collectRefs(person, deps);
      } catch (err) {
        if (err instanceof SidecarDownError) {
          await deps.onCheckpoint?.(snapshot());
          throw err;
        }
        const message = err instanceof Error ? err.message : String(err);
        deps.onProgress?.(`  FAILED ${person.name} (${person.id}): ${message}`);
        report.failed.push({ id: person.id, name: person.name, error: message });
        if (prior) results.set(person.id, { ...prior, name: person.name, aliases: person.aliases });
        else {
          results.set(person.id, undefined);
          if (priorExcluded) excludedNow.set(person.id, priorExcluded);
        }
        continue;
      }
    }
    if (refs.length >= MIN_REFS) {
      const entry = { id: person.id, name: person.name, aliases: person.aliases, refs };
      results.set(person.id, entry);
      report.included.push({ id: person.id, name: person.name, refs: refs.length });
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
