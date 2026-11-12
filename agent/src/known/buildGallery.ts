import type { FaceSidecarClient } from '../faces/sidecarClient';
import { decodeEmbedding, type Gallery, type GalleryPerson, type KnownPerson } from './gallery';
import type { WikimediaClient } from './wikimedia';

export const MAX_REFS = 10;
export const MIN_REFS = 3;
export const MIN_DET_SCORE = 0.6;
export const OUTLIER_COSINE = 0.35;
/** Stop downloading once this many usable faces are in hand (headroom for outlier removal). */
const COLLECT_LIMIT = MAX_REFS + 5;
const CATEGORY_DEPTH = 1;
const CATEGORY_LIMIT = 40;

export interface GalleryReport {
  included: { id: string; name: string; refs: number }[];
  excluded: { id: string; name: string; refs: number }[];
  averageRefs: number;
}

export interface BuildGalleryDeps {
  people: KnownPerson[];
  existing?: Gallery;
  rebuild?: string[];
  wikimedia: WikimediaClient;
  sidecar: FaceSidecarClient;
  download: (url: string) => Promise<Buffer>;
  onProgress?: (m: string) => void;
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

async function collectRefs(person: KnownPerson, deps: BuildGalleryDeps): Promise<Float32Array[]> {
  const { wikimedia, sidecar, download } = deps;
  const candidates: string[] = [];
  const portrait = await wikimedia.portrait(person.id);
  if (portrait) candidates.push(portrait);
  for (const title of await wikimedia.categoryFiles(person.id, { maxDepth: CATEGORY_DEPTH, limit: CATEGORY_LIMIT })) {
    if (!candidates.includes(title)) candidates.push(title);
  }

  const refs: Float32Array[] = [];
  for (const title of candidates) {
    if (refs.length >= COLLECT_LIMIT) break;
    try {
      const info = await wikimedia.fileInfo(title);
      if (!info || !wikimedia.isOpenLicense(info.license)) continue;
      const detection = await sidecar.detect(await download(info.thumbUrl));
      if (detection.faces.length !== 1) continue;
      const face = detection.faces[0];
      if (!(face.detScore >= MIN_DET_SCORE)) continue;
      refs.push(decodeEmbedding(face.embedding));
    } catch {
      // A bad file, a non-finite embedding or a transient failure only skips this candidate.
    }
  }

  if (refs.length === 0) return refs;
  const median = medianReference(refs);
  return refs.filter((r) => dot(r, median) >= OUTLIER_COSINE).slice(0, MAX_REFS);
}

/**
 * Builds (or incrementally updates) the known gallery. People already in `existing` (same model) keep
 * their refs unless listed in `rebuild`; people no longer in `people` are dropped. Images are downloaded
 * only to compute embeddings in memory; nothing but embeddings is kept.
 */
export async function buildGallery(deps: BuildGalleryDeps): Promise<{ gallery: Gallery; report: GalleryReport }> {
  const model = await deps.sidecar.model();
  const existing = deps.existing && deps.existing.model === model ? deps.existing : undefined;
  if (deps.existing && !existing) deps.onProgress?.(`Existing gallery is for model ${deps.existing.model}, rebuilding fully`);
  const kept = new Map(existing?.people.map((p) => [p.id, p]) ?? []);
  const rebuild = new Set(deps.rebuild ?? []);

  const people: GalleryPerson[] = [];
  const report: GalleryReport = { included: [], excluded: [], averageRefs: 0 };

  for (const [index, person] of deps.people.entries()) {
    const prior = kept.get(person.id);
    let refs: Float32Array[];
    if (prior && !rebuild.has(person.id)) {
      refs = prior.refs;
    } else {
      deps.onProgress?.(`[${index + 1}/${deps.people.length}] ${person.name} (${person.id})`);
      refs = await collectRefs(person, deps);
    }
    if (refs.length >= MIN_REFS) {
      people.push({ id: person.id, name: person.name, aliases: person.aliases, refs });
      report.included.push({ id: person.id, name: person.name, refs: refs.length });
    } else {
      report.excluded.push({ id: person.id, name: person.name, refs: refs.length });
    }
  }

  const total = report.included.reduce((sum, p) => sum + p.refs, 0);
  report.averageRefs = report.included.length ? total / report.included.length : 0;
  return { gallery: { model, people }, report };
}
