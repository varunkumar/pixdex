# Architecture

PixdeX is a browse and search UI for a personal photo collection. Original
photos never leave local disk or Google Drive; only derived data (metadata,
captions, ratings, thumbnails) lives in the cloud.

```
Your Mac
  ├─ Ollama (vision + text generation, local)
  ├─ agent/  (Node/TS CLI: index photos, serve originals)
  └─ cloudflared tunnel (originals on demand only)

Cloudflare
  ├─ worker/    Hono Worker: ingest + read API
  ├─ D1         photo metadata + FTS5 search index
  ├─ R2         thumbnails only
  └─ Pages      src/ (React UI) + functions/api (same-origin proxy)
```

Browsing and searching never needs the Mac: it is served from D1/R2. The Mac is
needed only to run an indexing pass or to fetch a full-resolution local original.
Drive-sourced photos deep-link to Drive and need no tunnel.

Original design rationale: `docs/superpowers/specs/2026-09-18-pixdex-local-cloud-redesign-design.md`.

## Components

### `src/` - frontend (React 19, Vite, Mantine, TanStack Query, react-router)

- `components/` - Search, Albums, AlbumPhotos, PhotoDetail, PhotoReview (stars
  and AI overrides), PhotoFaces/FaceTile (name and correct faces on the photo
  page), People (`/people`: named people plus unnamed face groups to name) and
  PersonPage (`/people/:id`: photos, rename/delete, suggestion review, re-run
  matching), Dashboard,
  DailySuggestion, Lightbox, PhotoGrid/PhotoCard, Layout.
- `services/api/WorkerApiClient.ts` - the only place that talks to the backend.
  It calls same-origin `/api/*`.
- `hooks/useListParams.ts` - sort/page state kept in the URL so listings are
  linkable and "back" returns to the same sort and page.
- `types/api.ts` - API response types shared by components.
- Tests sit next to code in `__tests__/`; helpers in `src/test/`.

### `functions/api/[[path]].ts` - Pages Function proxy

Same-origin read proxy. Adds `READ_TOKEN` server-side so it never ships in the
bundle. Only an allowlist of read routes is forwarded (`search`, `albums`,
`daily-pick`, `photos/:id`, `photos/:id/faces`, `thumbnails/:hash`, `people`,
`people/groups`) plus `originals/:id`, which goes
to the agent through the tunnel. `/ingest/*` is deliberately not reachable.
Thumbnails are cached immutably (content-hash addressed); other routes use
`no-cache`. The only writes the browser can make are `PUT albums/cover`,
`PATCH photos/:id`, `PATCH`/`DELETE people/:id`, and `POST` to `people`,
`people/:id/faces`, `people/:id/match` and `faces/:id/assign|reject|unassign`
(bodies JSON only, DELETE has none), all forwarded with the read token through
one shared helper with per-method allowlists.

### Human review (HITL)

Migration `0007_user_overrides.sql` adds `user_rating` (1-5), `user_caption`,
`user_subjects` and `user_tags` (NULL = no override). `PATCH /photos/:id`
(`routes/photos.ts`) sets them and rebuilds `search_text` from the effective
values (`db/photos.ts` `searchTextForRow`). `serializePhoto` returns the
effective `subjects`/`tags`/`shortCaption` plus `userRating`, `combinedScore`
and `overrides`. `/ingest/photo` upserts never touch the `user_*` columns and
index the override when one exists. `db/rating.ts` holds the blend
(`0.7 * stars*2 + 0.3 * aesthetic`, or aesthetic alone) as SQL and TS; search
`sort=rating`, album average rating and the daily pick all use it.

The daily pick (`worker/src/routes/daily-pick.ts`) is for nature, wildlife and
landscapes: photos whose subjects or description mention a person are never
picked (text match, since the index has no people field). It returns 404 if no
photo qualifies.

### `worker/` - Cloudflare Worker (Hono, D1, R2)

- Routes in `src/index.ts`. Ingest routes (`/ingest/*`) require `INGEST_TOKEN`;
  read routes require `READ_TOKEN` (`src/auth.ts`).
- `routes/search.ts` + `search/synonyms.ts` - FTS5 search (optional `people=<id>,<id>` "together" filter, max 5, all must appear via auto/confirmed faces) with query-time
  synonym expansion; no re-index is needed to change it. Category words
  (`search/wildlife-synonyms.json`, e.g. "big cat" -> leopard, tiger) and
  word families (`search/word-families.json`: "hard" nouns/places, "soft"
  actions) are matched on word boundaries with plurals folded. Search tries
  tiers until one finds photos (the dictionaries were built from the library's own
  vocabulary: `SELECT lower(value), COUNT(*) FROM photos, json_each(photos.subjects)
  GROUP BY 1 ORDER BY 2 DESC`, same for `tags`; the model already writes
  category and scientific names, so entries map between those variants): all groups (AND), then without soft action
  groups, then any group (OR, bm25-ranked). All terms are quoted. Colour
  words have families too (red/crimson/scarlet), and filler such as
  "shade" or "background" is ignored, so "tiger on a green background" is
  tiger AND green (colours are a photo-level list, not per region).
- Field weighting: `photos_fts` indexes two columns, `search_text` (everything)
  and `search_primary` (subjects, tags, colours, caption, with owner overrides).
  `bm25(photos_fts, 1.0, 4.0)` ranks primary matches higher. `search_primary`
  is written by ingest, `PATCH photos/:id` and `ingest/rating` via
  `primaryTextForRow` / `buildPrimaryText`; migration `0008` backfills it in
  SQL (no model calls).
- `db/photos.ts` - D1 queries. Schema changes are numbered SQL files in
  `migrations/` and registered in `migrations/index.ts`.
- Tests run in the Workers runtime via `@cloudflare/vitest-pool-workers`.

### `agent/` - local indexing agent (Node/TS, tsx)

- `cli.ts` is the entry point. Commands: `index-local`, `index-drive`,
  `index-batch`, `index-status`, `backfill-exif`, `backfill-ratings`,
  `backfill-faces`, `serve-originals`.
- Pipeline per photo (`processFile.ts`): hash content, skip if already indexed
  (`check-hashes`), read EXIF, make a thumbnail (sharp), ask Ollama for a
  description/tags/caption/quality rating, then push to the Worker.
- `batch/` - resumable multi-folder indexing with state in
  `agent/.index-state/` (gitignored). `scripts/install-launchd.sh` runs it at
  login.
- `google/` - OAuth + folder-scoped Drive listing (read-only scope).
- `originals/` - local server exposing full-resolution files, reached via
  `cloudflared` (`agent/cloudflared/`).

## Data flow

1. `agent` indexes: files -> hash -> Ollama analysis -> `POST /ingest/*` on the Worker.
2. Worker stores rows in D1 (with FTS5 text) and thumbnails in R2.
3. Browser -> Pages `/api/*` -> Pages Function adds token -> Worker read route.
4. "View Original": browser -> `/api/originals/:id` -> tunnel -> agent server
   (local files) or a Drive deep-link (Drive files).

## Config and secrets

| Where | Variables |
| --- | --- |
| Root `.env` / Pages secrets | `WORKER_URL`, `READ_TOKEN`, optional `ORIGINALS_BASE_URL`, `ORIGINALS_TOKEN`, `ACCESS_CLIENT_ID/SECRET` |
| `agent/.env` | `CLOUDFLARE_API_BASE_URL`, `INGEST_TOKEN`, `OLLAMA_*`, `GOOGLE_OAUTH_*`, `ORIGINALS_PORT/TOKEN`, `READ_TOKEN`, optional `FACE_SIDECAR_URL` (face scanning is off when unset) |
| Worker secrets | `READ_TOKEN`, `INGEST_TOKEN` |

Never prefix server-side secrets with `VITE_`.
