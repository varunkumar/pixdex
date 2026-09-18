# pixdex: local-agent + Cloudflare redesign

Date: 2026-09-18
Status: draft, pending review

## 1. Motivation

pixdex today is a single Express process (`src/server/index.ts`) that does
everything: scans local folders and Google Drive, calls OpenAI for vision
analysis and embeddings, writes metadata to a local Prisma/SQLite DB, and
writes embeddings to a ChromaDB container run via docker-compose. It's only
reachable on `localhost`.

This redesign is driven by five goals, in the user's words:

- **Go local/offline** — stop depending on OpenAI; use a local model via
  Ollama for all AI work.
- **Make it actually modern and usable.**
- **Use a modern tech stack/architecture** — open to replacing any current
  piece (Express, Chakra, Prisma, Chroma) if something fits better.
- **Optimize for storage** — specifically, avoid duplicate work/storage
  across the multiple drives photos are backed up on.
- **Extend Google Drive support** — today's Drive code lists every image
  in the whole Drive and has never been exercised; it needs to become a
  working one-time, folder-scoped indexing flow (no continuous sync).

An implicit sixth constraint emerged during design: the web UI should be
reachable from anywhere (Cloudflare-hosted), but **original photos must never
leave local disk or Google Drive** — only derived data (metadata, thumbnails)
may live in the cloud.

## 2. Architecture overview

The app splits into two halves that talk over a small HTTP API:

```
Your Mac
  ├─ Ollama (qwen3.5:27b-mlx — vision + text generation)
  ├─ Local Agent (Node/TS)
  │    reads: local folders, Google Drive API (one-time, folder-scoped)
  │    writes: metadata + thumbnails  →  pushed to Cloudflare
  │    serves: originals on demand    →  via Cloudflare Tunnel
  │
  └─ cloudflared tunnel (originals-on-demand only)

Cloudflare
  ├─ Workers (ingest API + search/browse API)
  ├─ D1 (photo metadata + FTS5 search index)
  ├─ R2 (thumbnails only — no originals)
  └─ Pages (React web UI, reachable from any browser)
```

Nothing about this requires the Mac to be on for **browsing/searching** —
that's served entirely from D1/R2 via Workers. The Mac (agent + tunnel) only
needs to be on for (a) running a new indexing pass, or (b) fetching a
full-resolution local-disk original. Google Drive-sourced photos don't need
the tunnel at all — full-res viewing deep-links straight to Drive.

This replaces the current single-process architecture entirely:
`ChromaVectorStore`, the docker-compose Chroma service, the Prisma+SQLite
local DB, and the embedding half of `LLMService` are all deleted, not kept
behind a flag. `Grok3Service` and `DeepSeekService` (unused stub/WIP
providers) are deleted too.

## 3. Local Agent

Replaces today's `src/server/index.ts` + `PhotoIndexer` + `OpenAIService`.
Runs only on your machine; never accepts inbound connections except through
the tunnel for originals.

**Responsibilities:**

- Present a small local-only UI (or CLI) to trigger an indexing run and pick
  which local folders or Google Drive folders to index. This is explicitly
  *not* part of the Cloudflare-hosted UI — indexing only ever happens at the
  machine that has the files and Ollama.
- For local folders: walk the directory tree, filter to image files (reusing
  the existing `isImageFile` logic).
- For Google Drive: let the user pick one or more folders (via Drive's
  folder picker/API), list image files scoped to those folders only —
  replacing today's untested `mimeType contains 'image/'` whole-Drive query.
  One-time indexing only; no watching, no incremental sync.
- **Dedup check before any expensive work**: compute a content hash (SHA-256
  of file bytes) per candidate file, batch-POST the hashes to the Workers
  `/ingest/check-hashes` endpoint, and skip any file whose hash is already
  known. This directly serves "avoid duplicate work/storage" — the same
  photo backed up on two drives, or already indexed once, never gets
  re-analyzed or re-thumbnailed.
- For genuinely new files: extract EXIF (reusing existing logic), call
  Ollama's vision endpoint for `analyzeImage`, generate a thumbnail (sharp),
  and push `{metadata, contentHash, thumbnail}` to the Workers ingest API.
- Serve full-resolution originals on demand, over the Cloudflare Tunnel,
  scoped strictly to paths that are already indexed (never an arbitrary
  filesystem read).

**LLM layer (`LLMService`) after the redesign:**

The interface shrinks to two calls — `generateEmbedding` is deleted
entirely, since search no longer uses vectors (see §5):

```ts
interface LLMService {
  analyzeImage(imagePath: string): Promise<ImageAnalysisResult>;
  generateText(prompt: string): Promise<string>; // captions, hashtags, daily-pick reasons
}
```

One implementation, `OllamaService`, replaces `OpenAIService` /
`Grok3Service` / `DeepSeekService`. It talks to a local Ollama instance over
HTTP using the vision-capable `qwen3.5:27b-mlx` model for both calls. The
existing image preprocessing (resize/reformat via sharp, size/format
validation) is reused as-is — that logic is provider-agnostic.

Caption/hashtag generation for the "daily pick" feature is generated
**during indexing**, not on demand, and stored in D1 alongside the photo's
metadata. This means the Cloudflare-hosted UI never needs to reach the local
agent/Ollama at browse time — daily-pick works even when your Mac is off.

## 4. Cloudflare side

**D1** — one `photos` table:

| column | notes |
|---|---|
| `id` | uuid, primary key |
| `content_hash` | sha256, unique — the dedup key |
| `source` | `local` \| `google_drive` |
| `path` / `drive_file_id` | source-specific locator |
| `filename`, `date_time`, `width`, `height`, `format`, `file_size` | as today |
| `subjects`, `colors`, `patterns`, `tags` | JSON arrays |
| `season`, `environment`, `album` | text |
| `description` | free text (LLM-generated prose) |
| `suggested_caption`, `suggested_hashtags` | pre-generated at index time |
| `model_provider`, `model_name` | which LLM produced this row's analysis, e.g. `ollama` / `qwen3.5:27b-mlx` |
| `last_indexed`, `instagram_suggested` | timestamps |

`model_provider`/`model_name` carry forward the `modelInfo` concept already
present in today's schema (`dbPhoto.modelName`/`modelVersion`/`modelType`).
Recording them per-row means a future model upgrade doesn't require guessing
which photos are stale: the local agent can query
`/photos?model_name!=<new model>` (or similar) to find everything indexed by
an older model and selectively re-run analysis on just those, without
touching photos already analyzed by the current model. This is also what
makes swapping `OllamaService`'s model, or adding a second `LLMService`
implementation later, low-cost — the data itself records its provenance.

Plus an FTS5 virtual table (`photos_fts`) indexing `subjects`,
`description`, `tags`, `environment`, `album` for search — see §5.

**R2** — thumbnails only, one object per photo keyed by `content_hash`.
Nothing else is stored here.

**Workers** — two API surfaces:
- *Ingest* (`/ingest/check-hashes`, `/ingest/photo`): authenticated with a
  single API token (this is a personal app, not multi-tenant), called only
  by the local agent.
- *Browse/search* (`/search`, `/photos/:id`, `/albums`, `/daily-pick`):
  called by the Pages UI, public or behind Cloudflare Access.

**Pages** — the React frontend, kept as React/Vite/TanStack Query (still a
reasonable "modern" choice and not a pain point that was raised); free to
swap Chakra for a lighter UI kit as part of the "make it usable" pass, but
that's a UI-layer decision, not an architectural one, and can be resolved
during implementation rather than in this spec.

## 5. Search: FTS5, not vector embeddings

D1 gets full-text search for free via SQLite's built-in FTS5 module
(porter-stemmed, so "leopards"/"leopard" match as one token). It does **not**
support `sqlite-vec` or any vector extension, and Cloudflare Vectorize
requires the $5/mo Workers Paid plan — so building a "free" vector search by
hand in D1 isn't actually viable either (brute-force cosine similarity over
tens of thousands of vectors would blow Workers' CPU-time limits). Given
that, and that this is a closed, well-known domain (wildlife species and
categories, not open-domain text), the design uses FTS5/BM25 as the entire
search mechanism, with **two explicit mitigations** for its core weakness —
that it's lexical, not semantic, so "big cat" won't match a photo tagged only
"leopard":

1. **Broader tags at generation time.** The vision prompt sent to Ollama is
   extended to explicitly ask for both the specific subject and its broader
   category — e.g. "leopard" *and* "big cat"; "monitor lizard" *and*
   "reptile"; "osprey" *and* "raptor". This writes the synonym directly into
   the `tags` field, so a search for "big cat" becomes a genuine FTS5 hit
   rather than something the search layer has to infer. This is a one-line
   change to the existing analysis prompt in `OllamaService.analyzeImage`.

2. **Query-time expansion via a small curated synonym/taxonomy dictionary.**
   A JSON file (e.g. `src/services/search/wildlife-synonyms.json`) maps
   common category terms to the specific species/terms they cover:
   ```json
   {
     "big cat": ["leopard", "tiger", "lion", "jaguar", "cheetah", "panther"],
     "raptor": ["eagle", "hawk", "osprey", "falcon", "kite"],
     "waterfowl": ["duck", "goose", "heron", "egret", "stork"]
   }
   ```
   Before a query hits FTS5, the Workers search endpoint expands any matched
   dictionary term into an `OR` of its members (e.g. `big cat` →
   `(leopard OR tiger OR lion OR jaguar OR cheetah OR panther OR "big cat")`).
   Because wildlife naming is a bounded, well-known vocabulary — unlike
   general language, where the paraphrase space is unbounded — a small
   hand-maintained dictionary gets disproportionately good precision here,
   and it's trivial to extend as gaps are found in practice.

Together with the fact that `description` is LLM-generated free-text prose
(so incidental vocabulary like "stalking" or "waterhole" gets indexed even
when it's not an explicit tag), this is expected to cover the large majority
of real searches. It is **not** a permanent ceiling: nothing in the D1/FTS5
design blocks adding Vectorize later as an additive layer if real usage
shows a gap the two mitigations above don't cover. That's explicitly out of
scope for this redesign (YAGNI) — it's not being built speculatively.

## 6. Data flow

**Indexing (local or Drive, always user-triggered, never automatic):**
1. User picks folder(s) in the local agent's UI.
2. Agent walks/lists files, computes content hashes, batch-checks them
   against D1 via `/ingest/check-hashes`.
3. For each unknown hash: EXIF extract → Ollama vision analysis → Ollama
   text generation (caption/hashtags) → thumbnail generation → push to
   `/ingest/photo`.
4. Workers writes the D1 row (+ FTS5 index update) and the R2 thumbnail.

**Search/browse (from anywhere, agent doesn't need to be running):**
1. Pages UI → Workers `/search?q=...&filters=...`.
2. Workers expands any synonym-dictionary terms in the query, runs FTS5 +
   structured `WHERE` filters (album, date range, location, season) against
   D1, returns metadata + R2 thumbnail URLs.
3. "Open original": for Drive photos, deep-link to Drive's viewer directly.
   For local-disk photos, request through the Cloudflare Tunnel; if the
   agent/tunnel is offline, the UI shows "original not available — agent
   offline" rather than erroring, and still shows the thumbnail.

**Daily pick:** scored and selected from D1 data alone (no live LLM call
needed at request time, since caption/hashtags were pre-generated during
indexing — see §3).

## 7. Error handling

- Ingest is per-file and idempotent, keyed by `content_hash` — a crashed or
  interrupted indexing run simply resumes; there's no batch-spanning
  transaction to recover.
- Ollama call failures (timeout, model not loaded, malformed response) are
  caught per-file, logged, and skipped, matching today's `PhotoIndexer`
  pattern — one bad photo never aborts a batch.
- The ingest endpoint validates payloads with zod before writing to D1.
- The tunnel-served originals endpoint only serves paths that are already
  present in the indexed set — never an arbitrary filesystem read.

## 8. Testing

- Unit tests for hashing/dedup logic and for query-expansion (synonym
  dictionary lookup, filter combination) — these run against a real SQLite
  file locally, no Cloudflare dependency.
- Workers API gets integration tests via `wrangler dev`/Miniflare.
- The local agent's Ollama integration gets a thin integration test gated
  behind an env var (e.g. `OLLAMA_TEST=1`), so CI doesn't require Ollama to
  be installed to pass.

## 9. What gets deleted

- `src/services/vectorstore/VectorStore.ts` (ChromaDB) and the
  `chroma:up`/`chroma:down`/`chroma:logs` docker-compose scripts.
- `generateEmbedding` from `LLMService` and every implementation.
- `src/services/llm/DeepSeekService.ts` (unused Python-subprocess WIP) and
  the `Grok3Service` stub in `LLMService.ts`.
- Prisma + local SQLite as the metadata store (superseded by D1).
- The current unscoped, untested "list every image in the whole Drive" query
  in `PhotoIndexer.indexGoogleDrivePhotos`.

## 10. Out of scope for this redesign

- Vector/semantic search (Vectorize or otherwise) — explicitly deferred; see
  §5.
- Continuous Google Drive sync / change watching — explicitly not wanted.
- Multiple Drive accounts or Shared Drives — not raised as a need.
- UI kit choice (Chakra vs. something else) — a UI-layer decision to make
  during implementation, not an architectural one.
