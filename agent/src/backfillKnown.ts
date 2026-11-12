import type { CloudflareClient } from './cloudflareClient';
import { EMBEDDING_DIM, type Gallery } from './known/gallery';
import { matchKnown } from './known/matcher';

export interface BackfillKnownResult {
  scanned: number;
  /** Faces whose stored embedding could not be decoded (wrong length, non-finite, zero norm). */
  skipped: number;
  matched: number;
  /** Rescore only: faces sent with knownId null because they no longer match anyone. */
  cleared: number;
  /** Rows the Worker reports as changed (unchanged rows are not written; always 0 in a dry run). */
  written: number;
  perPerson: { id: string; name: string; count: number }[];
  /** Score histogram of matches in 0.05 buckets, keyed by the lower bound with two decimals ("0.55"). */
  scoreBuckets: Record<string, number>;
  samples: { faceId: string; knownId: string; score: number }[];
}

const WRITE_BATCH = 200;
const SAMPLE_COUNT = 10;

/** L2-normalises a stored embedding; undefined when it cannot be used. */
function normalise(raw: Float32Array): Float32Array | undefined {
  if (raw.length !== EMBEDDING_DIM) return undefined;
  let sum = 0;
  for (let i = 0; i < raw.length; i++) {
    if (!Number.isFinite(raw[i])) return undefined;
    sum += raw[i] * raw[i];
  }
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) return undefined;
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw[i] / norm;
  return out;
}

/**
 * Matches already stored faces against the known gallery. `model` is the detection model the Worker stores
 * embeddings under; the CLI passes gallery.model (the gallery was built with the same sidecar model), so the
 * sidecar does not need to be running. Pages follow the Worker's X-Next-Cursor (an empty page can carry one).
 * Without `rescore` only faces with no known match are paged; with it all faces of the model are, and faces
 * that no longer match are cleared. Re-running is idempotent.
 */
export async function backfillKnown(deps: {
  cloudflareClient: CloudflareClient;
  gallery: Gallery;
  model: string;
  dryRun?: boolean;
  rescore?: boolean;
  /** Faces per Worker page (the Worker accepts 1 to 100, default 100). Lower it if the embeddings route nears 10 ms CPU. */
  pageSize?: number;
  onProgress?: (message: string) => void;
}): Promise<BackfillKnownResult> {
  const { cloudflareClient, gallery, model, dryRun = false, rescore = false, pageSize, onProgress } = deps;
  if (model !== gallery.model) {
    throw new Error(
      `Face model "${model}" does not match the gallery model "${gallery.model}". Rebuild the gallery with build-known-gallery --full using the current sidecar.`
    );
  }

  const result: BackfillKnownResult = {
    scanned: 0,
    skipped: 0,
    matched: 0,
    cleared: 0,
    written: 0,
    perPerson: [],
    scoreBuckets: {},
    samples: [],
  };
  const names = new Map(gallery.people.map((p) => [p.id, p.name]));
  const counts = new Map<string, number>();
  let pending: { faceId: string; knownId: string | null; score?: number }[] = [];

  const flush = async () => {
    if (dryRun || pending.length === 0) {
      pending = [];
      return;
    }
    const batch = pending;
    pending = [];
    try {
      result.written += await cloudflareClient.setFaceKnown(batch);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/failed: 400/.test(message)) {
        throw new Error(
          `${message}. The Worker rejected a known id it does not have; rerun build-known-gallery to upsert the known people, then retry.`
        );
      }
      throw error;
    }
  };

  let cursor: number | undefined;
  let pages = 0;
  do {
    const page = await cloudflareClient.faceEmbeddingsPage(model, { cursor, rescore, ...(pageSize !== undefined ? { limit: pageSize } : {}) });
    pages++;
    for (const face of page.faces) {
      result.scanned++;
      const embedding = normalise(face.embedding);
      if (!embedding) {
        result.skipped++;
        continue;
      }
      const match = matchKnown(embedding, gallery);
      if (match) {
        result.matched++;
        counts.set(match.id, (counts.get(match.id) ?? 0) + 1);
        const bucket = (Math.floor(match.score / 0.05 + 1e-9) * 0.05).toFixed(2);
        result.scoreBuckets[bucket] = (result.scoreBuckets[bucket] ?? 0) + 1;
        if (result.samples.length < SAMPLE_COUNT) {
          result.samples.push({ faceId: face.id, knownId: match.id, score: match.score });
        }
        pending.push({ faceId: face.id, knownId: match.id, score: match.score });
      } else if (rescore) {
        result.cleared++;
        pending.push({ faceId: face.id, knownId: null });
      }
      if (pending.length >= WRITE_BATCH) await flush();
    }
    onProgress?.(
      `Page ${pages}: scanned ${result.scanned}, matched ${result.matched}${rescore ? `, cleared ${result.cleared}` : ''}${result.skipped ? `, skipped ${result.skipped}` : ''}${dryRun ? ' (dry run)' : `, changed ${result.written}`}`
    );

    const next = page.nextCursor;
    if (next !== undefined && (!Number.isFinite(next) || next <= (cursor ?? 0))) {
      throw new Error(`The Worker returned a cursor (${next}) that does not advance past ${cursor ?? 0}; aborting to avoid looping`);
    }
    cursor = next;
  } while (cursor !== undefined);
  await flush();

  result.perPerson = [...counts]
    .map(([id, count]) => ({ id, name: names.get(id) ?? id, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return result;
}
