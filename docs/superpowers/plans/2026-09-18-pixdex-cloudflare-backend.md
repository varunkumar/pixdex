# Cloudflare Backend (D1 + Workers ingest/search API) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Cloudflare Worker that stores photo metadata in D1, thumbnails in R2, and exposes an ingest API (for the local agent, built in a later plan) and a search/browse API (for the frontend, built in a later plan).

**Architecture:** A single Cloudflare Worker (Hono router) with a D1 binding (`DB`) for metadata + FTS5 search, and an R2 binding (`THUMBNAILS`) for thumbnail images. Ingest routes (`/ingest/*`) require a shared-secret bearer token; browse routes (`/search`, `/photos/:id`, `/albums`, `/daily-pick`, `/thumbnails/:key`) are open. This plan is self-contained — it produces a working, independently testable Worker with no dependency on the local agent or frontend, which are separate plans.

**Tech Stack:** Cloudflare Workers, D1 (SQLite + FTS5), R2, Hono (router), Zod (validation), Vitest + `@cloudflare/vitest-pool-workers` (tests run against real D1/R2 bindings in-process, no external `wrangler dev` needed).

**Spec:** `docs/superpowers/specs/2026-09-18-pixdex-local-cloud-redesign-design.md`

## Global Constraints

- Original photos are never uploaded to Cloudflare — only metadata and thumbnails ever leave the local machine. This Worker must never accept or store a full-resolution image. (spec §1, §4)
- D1 free tier: 5GB storage, 5M row-reads/day, 100K row-writes/day. (spec §4)
- R2 free tier: 10GB storage, 1M writes/mo, 10M reads/mo, thumbnails only. (spec §4)
- No Vectorize, no vector search of any kind. Search is FTS5 + a curated synonym dictionary, nothing else. (spec §5)
- Every photo row must record `model_provider` and `model_name` so future reindexing can target only stale rows. (spec §4, amendment)
- `/ingest/*` routes require a bearer token (`INGEST_TOKEN` secret); browse routes do not.

---

## File Structure

```
worker/
  wrangler.toml
  package.json
  vitest.config.ts
  migrations/
    0001_init.sql
  src/
    index.ts              # Hono app, route wiring
    types.ts              # Env bindings type
    auth.ts                # requireIngestToken middleware
    db/
      photos.ts            # row <-> domain object mapping, search_text builder
    search/
      synonyms.ts           # expandQuery() + dictionary loader
      wildlife-synonyms.json
    routes/
      ingest-check-hashes.ts
      ingest-photo.ts
      ingest-thumbnail.ts
      search.ts
      photos.ts             # GET /photos/:id, GET /albums
      daily-pick.ts
  test/
    ingest-check-hashes.test.ts
    ingest-photo.test.ts
    ingest-thumbnail.test.ts
    synonyms.test.ts
    search.test.ts
    photos.test.ts
    daily-pick.test.ts
```

---

### Task 1: Scaffold the Worker project

**Files:**
- Create: `worker/package.json`
- Create: `worker/wrangler.toml`
- Create: `worker/tsconfig.json`
- Create: `worker/vitest.config.ts`
- Create: `worker/src/types.ts`
- Create: `worker/src/index.ts`
- Test: `worker/test/health.test.ts`

**Interfaces:**
- Produces: `Env` type (`{ DB: D1Database; THUMBNAILS: R2Bucket; INGEST_TOKEN: string }`) in `worker/src/types.ts`, consumed by every later task.
- Produces: the Hono `app` default export from `worker/src/index.ts`, which every route task adds routes to.

- [ ] **Step 1: Create `worker/package.json`**

```json
{
  "name": "pixdex-worker",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "hono": "^4.6.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.6.0",
    "@cloudflare/workers-types": "^4.20260901.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "wrangler": "^3.80.0"
  }
}
```

- [ ] **Step 2: Create `worker/wrangler.toml`**

```toml
name = "pixdex-worker"
main = "src/index.ts"
compatibility_date = "2026-09-18"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "pixdex"
database_id = "REPLACE_AFTER_RUNNING_wrangler_d1_create"
migrations_dir = "migrations"

[[r2_buckets]]
binding = "THUMBNAILS"
bucket_name = "pixdex-thumbnails"
```

- [ ] **Step 3: Create `worker/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "types": ["@cloudflare/workers-types", "vitest/globals"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

- [ ] **Step 4: Create `worker/vitest.config.ts`**

```ts
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
      },
    },
  },
});
```

- [ ] **Step 5: Create `worker/src/types.ts`**

```ts
export interface Env {
  DB: D1Database;
  THUMBNAILS: R2Bucket;
  INGEST_TOKEN: string;
}
```

- [ ] **Step 6: Write the failing test — `worker/test/health.test.ts`**

```ts
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('GET /health', () => {
  it('returns 200 ok', async () => {
    const response = await SELF.fetch('https://example.com/health');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run (from `worker/`): `npm install && npm test`
Expected: FAIL — `worker/src/index.ts` does not exist yet.

- [ ] **Step 8: Create `worker/src/index.ts`**

```ts
import { Hono } from 'hono';
import type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.text('ok'));

export default app;
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add worker/package.json worker/wrangler.toml worker/tsconfig.json worker/vitest.config.ts worker/src/types.ts worker/src/index.ts worker/test/health.test.ts
git commit -m "Scaffold pixdex Cloudflare Worker with health check"
```

---

### Task 2: D1 schema — `photos` table + FTS5 index

**Files:**
- Create: `worker/migrations/0001_init.sql`
- Test: `worker/test/schema.test.ts`

**Interfaces:**
- Produces: the `photos` table (columns below) and `photos_fts` FTS5 virtual table, kept in sync by triggers, consumed by every ingest/search route task.

Columns on `photos`: `id TEXT PRIMARY KEY`, `content_hash TEXT NOT NULL UNIQUE`, `source TEXT NOT NULL`, `path TEXT`, `drive_file_id TEXT`, `filename TEXT NOT NULL`, `date_time TEXT`, `width INTEGER`, `height INTEGER`, `format TEXT`, `file_size INTEGER`, `subjects TEXT NOT NULL DEFAULT '[]'`, `colors TEXT NOT NULL DEFAULT '[]'`, `patterns TEXT NOT NULL DEFAULT '[]'`, `tags TEXT NOT NULL DEFAULT '[]'`, `season TEXT`, `environment TEXT`, `album TEXT`, `description TEXT NOT NULL DEFAULT ''`, `suggested_caption TEXT NOT NULL DEFAULT ''`, `suggested_hashtags TEXT NOT NULL DEFAULT '[]'`, `model_provider TEXT NOT NULL`, `model_name TEXT NOT NULL`, `search_text TEXT NOT NULL DEFAULT ''`, `last_indexed TEXT NOT NULL`, `instagram_suggested TEXT`.

`search_text` is a plain-text, space-joined denormalization of `subjects + tags + description + environment + album`, computed by application code at insert time (Task 5) — this is what `photos_fts` actually indexes, kept separate from the JSON columns so FTS5 isn't tokenizing JSON punctuation.

- [ ] **Step 1: Write the failing test — `worker/test/schema.test.ts`**

```ts
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('photos schema', () => {
  it('accepts an insert and is searchable via photos_fts', async () => {
    await env.DB.prepare(
      `INSERT INTO photos
         (id, content_hash, source, filename, subjects, tags, description,
          environment, album, model_provider, model_name, search_text, last_indexed)
       VALUES (?, ?, 'local', 'leopard.jpg', '["leopard"]', '["leopard","big cat"]',
               'A leopard resting in a tree', 'forest', 'Kanha', 'ollama',
               'qwen3.5:27b-mlx', 'leopard big cat leopard resting tree forest kanha',
               '2026-09-18T00:00:00.000Z')`
    )
      .bind('photo-1', 'hash-1')
      .run();

    const row = await env.DB.prepare('SELECT * FROM photos WHERE id = ?')
      .bind('photo-1')
      .first();
    expect(row?.filename).toBe('leopard.jpg');

    const match = await env.DB.prepare(
      `SELECT photos.id FROM photos
       JOIN photos_fts ON photos.rowid = photos_fts.rowid
       WHERE photos_fts MATCH 'leopard'`
    ).all();
    expect(match.results.map((r) => r.id)).toEqual(['photo-1']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `no such table: photos`

- [ ] **Step 3: Create `worker/migrations/0001_init.sql`**

```sql
CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  path TEXT,
  drive_file_id TEXT,
  filename TEXT NOT NULL,
  date_time TEXT,
  width INTEGER,
  height INTEGER,
  format TEXT,
  file_size INTEGER,
  subjects TEXT NOT NULL DEFAULT '[]',
  colors TEXT NOT NULL DEFAULT '[]',
  patterns TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  season TEXT,
  environment TEXT,
  album TEXT,
  description TEXT NOT NULL DEFAULT '',
  suggested_caption TEXT NOT NULL DEFAULT '',
  suggested_hashtags TEXT NOT NULL DEFAULT '[]',
  model_provider TEXT NOT NULL,
  model_name TEXT NOT NULL,
  search_text TEXT NOT NULL DEFAULT '',
  last_indexed TEXT NOT NULL,
  instagram_suggested TEXT
);

CREATE INDEX idx_photos_album ON photos(album);
CREATE INDEX idx_photos_date_time ON photos(date_time);

CREATE VIRTUAL TABLE photos_fts USING fts5(
  search_text,
  content = 'photos',
  content_rowid = 'rowid',
  tokenize = 'porter unicode61'
);

CREATE TRIGGER photos_ai AFTER INSERT ON photos BEGIN
  INSERT INTO photos_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;

CREATE TRIGGER photos_ad AFTER DELETE ON photos BEGIN
  INSERT INTO photos_fts(photos_fts, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
END;

CREATE TRIGGER photos_au AFTER UPDATE ON photos BEGIN
  INSERT INTO photos_fts(photos_fts, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
  INSERT INTO photos_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS (`@cloudflare/vitest-pool-workers` auto-applies `migrations/` against the test D1 instance)

- [ ] **Step 5: Commit**

```bash
git add worker/migrations/0001_init.sql worker/test/schema.test.ts
git commit -m "Add D1 schema: photos table with FTS5 search index"
```

---

### Task 3: Ingest auth middleware

**Files:**
- Create: `worker/src/auth.ts`
- Create: `worker/.dev.vars`
- Modify: `worker/src/index.ts`
- Test: `worker/test/auth.test.ts`

**Interfaces:**
- Consumes: `Env` from `worker/src/types.ts` (Task 1).
- Produces: `requireIngestToken` Hono middleware, applied to `/ingest/*` in `worker/src/index.ts`, reused unmodified by every ingest route task. Also produces a populated `INGEST_TOKEN` binding for local dev and tests — every later task's tests read it via `env.INGEST_TOKEN` (from `cloudflare:test`) to build the `Authorization` header.

- [ ] **Step 1: Create `worker/.dev.vars`**

`@cloudflare/vitest-pool-workers` and `wrangler dev` both read local-only bindings from this file. It's a fixed test/dev value, not a production secret — production sets `INGEST_TOKEN` via `wrangler secret put INGEST_TOKEN` instead, which never touches this file.

```
INGEST_TOKEN=test-ingest-token
```

- [ ] **Step 2: Write the failing test — `worker/test/auth.test.ts`**

```ts
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('ingest auth', () => {
  it('rejects requests with no token', async () => {
    const response = await SELF.fetch('https://example.com/ingest/check-hashes', {
      method: 'POST',
      body: JSON.stringify({ hashes: [] }),
    });
    expect(response.status).toBe(401);
  });

  it('rejects requests with the wrong token', async () => {
    const response = await SELF.fetch('https://example.com/ingest/check-hashes', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token' },
      body: JSON.stringify({ hashes: [] }),
    });
    expect(response.status).toBe(401);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `/ingest/check-hashes` route doesn't exist yet (404, not 401)

- [ ] **Step 4: Create `worker/src/auth.ts`**

```ts
import type { Context, Next } from 'hono';
import type { Env } from './types';

export async function requireIngestToken(
  c: Context<{ Bindings: Env }>,
  next: Next
) {
  const header = c.req.header('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';

  if (!token || token !== c.env.INGEST_TOKEN) {
    return c.text('Unauthorized', 401);
  }

  await next();
}
```

- [ ] **Step 5: Wire it into `worker/src/index.ts`**

```ts
import { Hono } from 'hono';
import { requireIngestToken } from './auth';
import type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.text('ok'));

app.use('/ingest/*', requireIngestToken);
app.post('/ingest/check-hashes', (c) => c.json({ known: [] })); // placeholder, replaced in Task 4

export default app;
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add worker/src/auth.ts worker/.dev.vars worker/src/index.ts worker/test/auth.test.ts
git commit -m "Add bearer-token auth middleware for /ingest routes"
```

---

### Task 4: `POST /ingest/check-hashes`

**Files:**
- Create: `worker/src/routes/ingest-check-hashes.ts`
- Modify: `worker/src/index.ts`
- Test: `worker/test/ingest-check-hashes.test.ts`

**Interfaces:**
- Consumes: `Env`, `requireIngestToken` (Task 3), `photos` table (Task 2).
- Produces: `checkHashesRoute` Hono handler. Request: `POST /ingest/check-hashes` with body `{ "hashes": string[] }` (max 500). Response: `{ "known": string[] }` — the subset of input hashes already present in `photos.content_hash`. Consumed by the local agent plan as the dedup pre-check.

- [ ] **Step 1: Write the failing test — `worker/test/ingest-check-hashes.test.ts`**

```ts
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

async function seedPhoto(hash: string) {
  await env.DB.prepare(
    `INSERT INTO photos (id, content_hash, source, filename, model_provider, model_name, search_text, last_indexed)
     VALUES (?, ?, 'local', 'a.jpg', 'ollama', 'qwen3.5:27b-mlx', '', '2026-09-18T00:00:00.000Z')`
  )
    .bind(crypto.randomUUID(), hash)
    .run();
}

describe('POST /ingest/check-hashes', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM photos').run();
  });

  it('returns only the hashes that already exist', async () => {
    await seedPhoto('known-hash');

    const response = await SELF.fetch('https://example.com/ingest/check-hashes', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.INGEST_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes: ['known-hash', 'unknown-hash'] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ known: ['known-hash'] });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — placeholder route always returns `{ known: [] }`

- [ ] **Step 3: Create `worker/src/routes/ingest-check-hashes.ts`**

```ts
import { z } from 'zod';
import type { Context } from 'hono';
import type { Env } from '../types';

const requestSchema = z.object({
  hashes: z.array(z.string()).max(500),
});

export async function checkHashesRoute(c: Context<{ Bindings: Env }>) {
  const body = requestSchema.safeParse(await c.req.json());
  if (!body.success) {
    return c.json({ error: body.error.flatten() }, 400);
  }

  const { hashes } = body.data;
  if (hashes.length === 0) {
    return c.json({ known: [] });
  }

  const placeholders = hashes.map(() => '?').join(',');
  const result = await c.env.DB.prepare(
    `SELECT content_hash FROM photos WHERE content_hash IN (${placeholders})`
  )
    .bind(...hashes)
    .all<{ content_hash: string }>();

  return c.json({ known: result.results.map((r) => r.content_hash) });
}
```

- [ ] **Step 4: Wire it into `worker/src/index.ts`**

```ts
import { checkHashesRoute } from './routes/ingest-check-hashes';
// ...
app.post('/ingest/check-hashes', checkHashesRoute); // replaces the Task 3 placeholder
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add worker/src/routes/ingest-check-hashes.ts worker/src/index.ts worker/test/ingest-check-hashes.test.ts
git commit -m "Add POST /ingest/check-hashes dedup endpoint"
```

---

### Task 5: `POST /ingest/photo` — metadata write

**Files:**
- Create: `worker/src/db/photos.ts`
- Create: `worker/src/routes/ingest-photo.ts`
- Modify: `worker/src/index.ts`
- Test: `worker/test/ingest-photo.test.ts`

**Interfaces:**
- Consumes: `Env`, `requireIngestToken` (Task 3), `photos`/`photos_fts` (Task 2).
- Produces: `buildSearchText(input)` in `worker/src/db/photos.ts` — pure function, `(subjects, tags, description, environment, album) => string`, reused by Task 6+ if metadata is ever re-derived. `ingestPhotoRoute` Hono handler for `POST /ingest/photo`, body matching `IngestPhotoInput` (fields listed in Step 3), inserts one `photos` row per call (id is caller-supplied, so retries are naturally idempotent via `INSERT OR REPLACE`).

- [ ] **Step 1: Write the failing test — `worker/test/ingest-photo.test.ts`**

```ts
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

const payload = {
  id: 'photo-1',
  contentHash: 'hash-1',
  source: 'local' as const,
  path: '/Users/me/Photos/leopard.jpg',
  filename: 'leopard.jpg',
  dateTime: '2026-01-05T10:00:00.000Z',
  width: 4000,
  height: 3000,
  format: 'jpeg',
  fileSize: 5_000_000,
  subjects: ['leopard'],
  colors: ['gold', 'green'],
  patterns: ['spots'],
  tags: ['leopard', 'big cat', 'tree'],
  season: 'winter',
  environment: 'dense forest',
  album: 'Kanha 2026',
  description: 'A leopard resting on a tree branch at dusk.',
  suggestedCaption: 'Golden hour, golden coat. 🐆',
  suggestedHashtags: ['leopard', 'wildlife', 'kanha'],
  modelProvider: 'ollama',
  modelName: 'qwen3.5:27b-mlx',
};

describe('POST /ingest/photo', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM photos').run();
  });

  it('inserts a photo row that is immediately searchable', async () => {
    const response = await SELF.fetch('https://example.com/ingest/photo', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.INGEST_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(201);

    const row = await env.DB.prepare('SELECT * FROM photos WHERE id = ?').bind('photo-1').first();
    expect(row?.filename).toBe('leopard.jpg');
    expect(row?.model_name).toBe('qwen3.5:27b-mlx');

    const match = await env.DB.prepare(
      `SELECT photos.id FROM photos JOIN photos_fts ON photos.rowid = photos_fts.rowid WHERE photos_fts MATCH 'leopard'`
    ).all();
    expect(match.results.map((r) => r.id)).toEqual(['photo-1']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `/ingest/photo` route doesn't exist yet (404)

- [ ] **Step 3: Create `worker/src/db/photos.ts`**

```ts
import { z } from 'zod';

export const ingestPhotoSchema = z.object({
  id: z.string().uuid(),
  contentHash: z.string().min(1),
  source: z.enum(['local', 'google_drive']),
  path: z.string().optional(),
  driveFileId: z.string().optional(),
  filename: z.string().min(1),
  dateTime: z.string().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  format: z.string().optional(),
  fileSize: z.number().int().optional(),
  subjects: z.array(z.string()).default([]),
  colors: z.array(z.string()).default([]),
  patterns: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  season: z.string().optional(),
  environment: z.string().optional(),
  album: z.string().optional(),
  description: z.string().default(''),
  suggestedCaption: z.string().default(''),
  suggestedHashtags: z.array(z.string()).default([]),
  modelProvider: z.string().min(1),
  modelName: z.string().min(1),
});

export type IngestPhotoInput = z.infer<typeof ingestPhotoSchema>;

export function buildSearchText(input: {
  subjects: string[];
  tags: string[];
  description: string;
  environment?: string;
  album?: string;
}): string {
  return [
    ...input.subjects,
    ...input.tags,
    input.description,
    input.environment ?? '',
    input.album ?? '',
  ]
    .filter(Boolean)
    .join(' ');
}
```

- [ ] **Step 4: Create `worker/src/routes/ingest-photo.ts`**

```ts
import type { Context } from 'hono';
import type { Env } from '../types';
import { buildSearchText, ingestPhotoSchema } from '../db/photos';

export async function ingestPhotoRoute(c: Context<{ Bindings: Env }>) {
  const parsed = ingestPhotoSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }
  const p = parsed.data;
  const searchText = buildSearchText(p);
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    `INSERT INTO photos (
       id, content_hash, source, path, drive_file_id, filename, date_time,
       width, height, format, file_size, subjects, colors, patterns, tags,
       season, environment, album, description, suggested_caption,
       suggested_hashtags, model_provider, model_name, search_text, last_indexed
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       content_hash = excluded.content_hash,
       subjects = excluded.subjects,
       colors = excluded.colors,
       patterns = excluded.patterns,
       tags = excluded.tags,
       season = excluded.season,
       environment = excluded.environment,
       description = excluded.description,
       suggested_caption = excluded.suggested_caption,
       suggested_hashtags = excluded.suggested_hashtags,
       model_provider = excluded.model_provider,
       model_name = excluded.model_name,
       search_text = excluded.search_text,
       last_indexed = excluded.last_indexed`
  )
    .bind(
      p.id, p.contentHash, p.source, p.path ?? null, p.driveFileId ?? null, p.filename,
      p.dateTime ?? null, p.width ?? null, p.height ?? null, p.format ?? null, p.fileSize ?? null,
      JSON.stringify(p.subjects), JSON.stringify(p.colors), JSON.stringify(p.patterns), JSON.stringify(p.tags),
      p.season ?? null, p.environment ?? null, p.album ?? null, p.description,
      p.suggestedCaption, JSON.stringify(p.suggestedHashtags), p.modelProvider, p.modelName,
      searchText, now
    )
    .run();

  return c.json({ id: p.id }, 201);
}
```

- [ ] **Step 5: Wire it into `worker/src/index.ts`**

```ts
import { ingestPhotoRoute } from './routes/ingest-photo';
// ...
app.post('/ingest/photo', ingestPhotoRoute);
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add worker/src/db/photos.ts worker/src/routes/ingest-photo.ts worker/src/index.ts worker/test/ingest-photo.test.ts
git commit -m "Add POST /ingest/photo metadata-write endpoint"
```

---

### Task 6: Thumbnail upload + retrieval (R2)

**Files:**
- Create: `worker/src/routes/ingest-thumbnail.ts`
- Modify: `worker/src/index.ts`
- Test: `worker/test/ingest-thumbnail.test.ts`

**Interfaces:**
- Consumes: `Env.THUMBNAILS` (R2 binding, Task 1), `requireIngestToken` (Task 3).
- Produces: `PUT /ingest/thumbnail/:contentHash` (auth required, raw `image/jpeg` body, stores at R2 key `${contentHash}.jpg`) and `GET /thumbnails/:contentHash` (no auth, streams the stored bytes back with `Content-Type: image/jpeg`, 404 if missing). The `contentHash` path param is the same value used in `ingestPhotoSchema.contentHash` (Task 5), so the frontend (later plan) can construct thumbnail URLs directly from a photo's `content_hash`.

- [ ] **Step 1: Write the failing test — `worker/test/ingest-thumbnail.test.ts`**

```ts
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('thumbnail upload + retrieval', () => {
  it('round-trips bytes through R2', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);

    const put = await SELF.fetch('https://example.com/ingest/thumbnail/hash-1', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${env.INGEST_TOKEN}`, 'Content-Type': 'image/jpeg' },
      body: bytes,
    });
    expect(put.status).toBe(201);

    const get = await SELF.fetch('https://example.com/thumbnails/hash-1');
    expect(get.status).toBe(200);
    expect(get.headers.get('Content-Type')).toBe('image/jpeg');
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
  });

  it('returns 404 for a missing thumbnail', async () => {
    const get = await SELF.fetch('https://example.com/thumbnails/does-not-exist');
    expect(get.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — routes don't exist yet (404 on the PUT)

- [ ] **Step 3: Create `worker/src/routes/ingest-thumbnail.ts`**

```ts
import type { Context } from 'hono';
import type { Env } from '../types';

function keyFor(contentHash: string): string {
  return `${contentHash}.jpg`;
}

export async function putThumbnailRoute(c: Context<{ Bindings: Env }>) {
  const contentHash = c.req.param('contentHash');
  const bytes = await c.req.arrayBuffer();
  await c.env.THUMBNAILS.put(keyFor(contentHash), bytes, {
    httpMetadata: { contentType: 'image/jpeg' },
  });
  return c.text('created', 201);
}

export async function getThumbnailRoute(c: Context<{ Bindings: Env }>) {
  const contentHash = c.req.param('contentHash');
  const object = await c.env.THUMBNAILS.get(keyFor(contentHash));
  if (!object) {
    return c.text('Not Found', 404);
  }
  return new Response(object.body, {
    headers: { 'Content-Type': object.httpMetadata?.contentType ?? 'image/jpeg' },
  });
}
```

- [ ] **Step 4: Wire it into `worker/src/index.ts`**

```ts
import { getThumbnailRoute, putThumbnailRoute } from './routes/ingest-thumbnail';
// ...
app.put('/ingest/thumbnail/:contentHash', putThumbnailRoute); // under the /ingest/* auth guard
app.get('/thumbnails/:contentHash', getThumbnailRoute); // outside the guard, public
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add worker/src/routes/ingest-thumbnail.ts worker/src/index.ts worker/test/ingest-thumbnail.test.ts
git commit -m "Add thumbnail upload/retrieval via R2"
```

---

### Task 7: Synonym dictionary + query expansion

**Files:**
- Create: `worker/src/search/wildlife-synonyms.json`
- Create: `worker/src/search/synonyms.ts`
- Test: `worker/test/synonyms.test.ts`

**Interfaces:**
- Produces: `expandQuery(rawQuery: string, synonyms: Record<string, string[]>): string` — pure function, no Workers runtime needed to test. Returns an FTS5 `MATCH` expression string (double-quoted phrase terms OR'd together). Consumed by the search route in Task 8. Also produces `wildlifeSynonyms: Record<string, string[]>` (the default dictionary import) for the search route to pass in.

- [ ] **Step 1: Write the failing test — `worker/test/synonyms.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { expandQuery } from '../src/search/synonyms';

const dict = {
  'big cat': ['leopard', 'tiger', 'lion', 'jaguar', 'cheetah', 'panther'],
  raptor: ['eagle', 'hawk', 'osprey', 'falcon', 'kite'],
};

describe('expandQuery', () => {
  it('expands a recognized category term into an OR of its members', () => {
    const result = expandQuery('big cat', dict);
    expect(result).toContain('"leopard"');
    expect(result).toContain('"tiger"');
    expect(result).toContain('"big cat"');
    expect(result.split(' OR ').length).toBeGreaterThan(1);
  });

  it('passes an unrecognized term through unchanged, just quoted', () => {
    expect(expandQuery('elephant', dict)).toBe('"elephant"');
  });

  it('returns an empty string for an empty query', () => {
    expect(expandQuery('   ', dict)).toBe('');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `worker/src/search/synonyms.ts` does not exist yet

- [ ] **Step 3: Create `worker/src/search/wildlife-synonyms.json`**

```json
{
  "big cat": ["leopard", "tiger", "lion", "jaguar", "cheetah", "panther"],
  "raptor": ["eagle", "hawk", "osprey", "falcon", "kite"],
  "waterfowl": ["duck", "goose", "heron", "egret", "stork"],
  "primate": ["monkey", "langur", "macaque", "gibbon"],
  "reptile": ["monitor lizard", "crocodile", "snake", "turtle"]
}
```

- [ ] **Step 4: Create `worker/src/search/synonyms.ts`**

```ts
import wildlifeSynonyms from './wildlife-synonyms.json';

export { wildlifeSynonyms };

function quoteFts5Term(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

export function expandQuery(rawQuery: string, synonyms: Record<string, string[]>): string {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return '';

  const matchedKeys = Object.keys(synonyms).filter((key) => query.includes(key));

  const terms = new Set<string>();
  terms.add(quoteFts5Term(query));

  for (const key of matchedKeys) {
    terms.add(quoteFts5Term(key));
    for (const synonym of synonyms[key]) {
      terms.add(quoteFts5Term(synonym));
    }
  }

  return Array.from(terms).join(' OR ');
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add worker/src/search/wildlife-synonyms.json worker/src/search/synonyms.ts worker/test/synonyms.test.ts
git commit -m "Add wildlife synonym dictionary and FTS5 query expansion"
```

---

### Task 8: `GET /search`

**Files:**
- Create: `worker/src/routes/search.ts`
- Modify: `worker/src/index.ts`
- Test: `worker/test/search.test.ts`

**Interfaces:**
- Consumes: `expandQuery`, `wildlifeSynonyms` (Task 7); `photos`/`photos_fts` (Task 2).
- Produces: `GET /search?q=<text>&album=<name>&limit=<n>&offset=<n>` — no auth. Response: `{ results: PhotoSearchResult[] }` where each result is the full `photos` row with JSON columns parsed back into arrays and a `thumbnailUrl` field set to `/thumbnails/${content_hash}` (matches Task 6's `GET /thumbnails/:contentHash` route). Consumed directly by the frontend plan.

- [ ] **Step 1: Write the failing test — `worker/test/search.test.ts`**

```ts
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

async function seed(id: string, contentHash: string, subjects: string[], searchText: string, album: string) {
  await env.DB.prepare(
    `INSERT INTO photos (id, content_hash, source, filename, subjects, album, model_provider, model_name, search_text, last_indexed)
     VALUES (?,?,'local',?,?,?, 'ollama', 'qwen3.5:27b-mlx', ?, '2026-09-18T00:00:00.000Z')`
  )
    .bind(id, contentHash, `${id}.jpg`, JSON.stringify(subjects), album, searchText)
    .run();
}

describe('GET /search', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM photos').run();
    await seed('photo-leopard', 'hash-leopard', ['leopard'], 'leopard big cat forest', 'Kanha');
    await seed('photo-elephant', 'hash-elephant', ['elephant'], 'elephant herd grassland', 'Kaziranga');
  });

  it('finds a synonym-expanded match via "big cat"', async () => {
    const response = await SELF.fetch('https://example.com/search?q=big%20cat');
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.results.map((r: { id: string }) => r.id)).toEqual(['photo-leopard']);
    expect(body.results[0].thumbnailUrl).toBe('/thumbnails/hash-leopard');
    expect(body.results[0].subjects).toEqual(['leopard']);
  });

  it('filters by album', async () => {
    const response = await SELF.fetch('https://example.com/search?album=Kaziranga');
    const body = await response.json();
    expect(body.results.map((r: { id: string }) => r.id)).toEqual(['photo-elephant']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `/search` route doesn't exist yet (404)

- [ ] **Step 3: Create `worker/src/routes/search.ts`**

```ts
import type { Context } from 'hono';
import type { Env } from '../types';
import { expandQuery, wildlifeSynonyms } from '../search/synonyms';

interface PhotoRow {
  id: string;
  content_hash: string;
  filename: string;
  subjects: string;
  colors: string;
  patterns: string;
  tags: string;
  suggested_hashtags: string;
  [key: string]: unknown;
}

function parseRow(row: PhotoRow) {
  return {
    ...row,
    subjects: JSON.parse(row.subjects),
    colors: JSON.parse(row.colors),
    patterns: JSON.parse(row.patterns),
    tags: JSON.parse(row.tags),
    suggestedHashtags: JSON.parse(row.suggested_hashtags),
    thumbnailUrl: `/thumbnails/${row.content_hash}`,
  };
}

export async function searchRoute(c: Context<{ Bindings: Env }>) {
  const q = c.req.query('q');
  const album = c.req.query('album');
  const limit = Math.min(Number(c.req.query('limit') ?? '20'), 100);
  const offset = Number(c.req.query('offset') ?? '0');

  const conditions: string[] = [];
  const params: unknown[] = [];
  let sql: string;

  if (q) {
    sql = `SELECT photos.* FROM photos JOIN photos_fts ON photos.rowid = photos_fts.rowid WHERE photos_fts MATCH ?`;
    params.push(expandQuery(q, wildlifeSynonyms));
  } else {
    sql = `SELECT * FROM photos WHERE 1=1`;
  }

  if (album) {
    conditions.push('album = ?');
    params.push(album);
  }

  if (conditions.length > 0) {
    sql += ` AND ${conditions.join(' AND ')}`;
  }

  sql += ` ORDER BY last_indexed DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const result = await c.env.DB.prepare(sql).bind(...params).all<PhotoRow>();
  return c.json({ results: result.results.map(parseRow) });
}
```

- [ ] **Step 4: Wire it into `worker/src/index.ts`**

```ts
import { searchRoute } from './routes/search';
// ...
app.get('/search', searchRoute);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add worker/src/routes/search.ts worker/src/index.ts worker/test/search.test.ts
git commit -m "Add GET /search with FTS5 + synonym expansion + album filter"
```

---

### Task 9: `GET /photos/:id` and `GET /albums`

**Files:**
- Create: `worker/src/routes/photos.ts`
- Modify: `worker/src/index.ts`
- Test: `worker/test/photos.test.ts`

**Interfaces:**
- Consumes: `photos` table (Task 2), the `parseRow`-style shape established in Task 8 (duplicated here since it's a separate small file — no shared helper needed for two call sites).
- Produces: `GET /photos/:id` → single parsed photo object or 404. `GET /albums` → `{ albums: string[] }`, distinct non-null `album` values.

- [ ] **Step 1: Write the failing test — `worker/test/photos.test.ts`**

```ts
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

describe('GET /photos/:id and GET /albums', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM photos').run();
    await env.DB.prepare(
      `INSERT INTO photos (id, content_hash, source, filename, subjects, colors, patterns, tags, suggested_hashtags, album, model_provider, model_name, search_text, last_indexed)
       VALUES ('photo-1','hash-1','local','a.jpg','[]','[]','[]','[]','[]','Kanha','ollama','qwen3.5:27b-mlx','','2026-09-18T00:00:00.000Z')`
    ).run();
  });

  it('GET /photos/:id returns the photo', async () => {
    const response = await SELF.fetch('https://example.com/photos/photo-1');
    expect(response.status).toBe(200);
    expect((await response.json()).filename).toBe('a.jpg');
  });

  it('GET /photos/:id returns 404 for an unknown id', async () => {
    const response = await SELF.fetch('https://example.com/photos/does-not-exist');
    expect(response.status).toBe(404);
  });

  it('GET /albums returns distinct album names', async () => {
    const response = await SELF.fetch('https://example.com/albums');
    expect(await response.json()).toEqual({ albums: ['Kanha'] });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — routes don't exist yet (404 on both)

- [ ] **Step 3: Create `worker/src/routes/photos.ts`**

```ts
import type { Context } from 'hono';
import type { Env } from '../types';

interface PhotoRow {
  subjects: string;
  colors: string;
  patterns: string;
  tags: string;
  suggested_hashtags: string;
  content_hash: string;
  [key: string]: unknown;
}

function parseRow(row: PhotoRow) {
  return {
    ...row,
    subjects: JSON.parse(row.subjects),
    colors: JSON.parse(row.colors),
    patterns: JSON.parse(row.patterns),
    tags: JSON.parse(row.tags),
    suggestedHashtags: JSON.parse(row.suggested_hashtags),
    thumbnailUrl: `/thumbnails/${row.content_hash}`,
  };
}

export async function getPhotoRoute(c: Context<{ Bindings: Env }>) {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT * FROM photos WHERE id = ?').bind(id).first<PhotoRow>();
  if (!row) {
    return c.text('Not Found', 404);
  }
  return c.json(parseRow(row));
}

export async function getAlbumsRoute(c: Context<{ Bindings: Env }>) {
  const result = await c.env.DB.prepare(
    'SELECT DISTINCT album FROM photos WHERE album IS NOT NULL ORDER BY album'
  ).all<{ album: string }>();
  return c.json({ albums: result.results.map((r) => r.album) });
}
```

- [ ] **Step 4: Wire it into `worker/src/index.ts`**

```ts
import { getAlbumsRoute, getPhotoRoute } from './routes/photos';
// ...
app.get('/photos/:id', getPhotoRoute);
app.get('/albums', getAlbumsRoute);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add worker/src/routes/photos.ts worker/src/index.ts worker/test/photos.test.ts
git commit -m "Add GET /photos/:id and GET /albums"
```

---

### Task 10: `GET /daily-pick`

**Files:**
- Create: `worker/src/routes/daily-pick.ts`
- Modify: `worker/src/index.ts`
- Test: `worker/test/daily-pick.test.ts`

**Interfaces:**
- Consumes: `photos` table (Task 2). Reuses the scoring approach from today's `PhotoIndexer.getDailySuggestion` (`src/services/indexer/PhotoIndexer.ts:720-821` in the current codebase): +2 per subject, +0.1 per description word, +5 if in-season, skip photos suggested in the last 90 days unless none remain eligible.
- Produces: `GET /daily-pick` — no auth. Picks the highest-scoring eligible photo, sets its `instagram_suggested` to now, and returns `{ photo, reason, suggestedCaption, suggestedHashtags }` using the **pre-generated** `suggested_caption`/`suggested_hashtags` columns (no live LLM call — matches spec §3/§6, since captions are generated at index time by the local agent).

- [ ] **Step 1: Write the failing test — `worker/test/daily-pick.test.ts`**

```ts
import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

async function seed(id: string, subjects: string[], description: string, instagramSuggested: string | null) {
  await env.DB.prepare(
    `INSERT INTO photos (id, content_hash, source, filename, subjects, description, suggested_caption, suggested_hashtags, model_provider, model_name, search_text, last_indexed, instagram_suggested)
     VALUES (?,?,'local',?,?,?, 'caption', '[]', 'ollama', 'qwen3.5:27b-mlx', '', '2026-09-18T00:00:00.000Z', ?)`
  )
    .bind(id, `hash-${id}`, `${id}.jpg`, JSON.stringify(subjects), description, instagramSuggested)
    .run();
}

describe('GET /daily-pick', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM photos').run();
  });

  it('picks the photo with more subjects and a longer description over a never-suggested sparse one', async () => {
    await seed('sparse', ['leopard'], 'A leopard.', null);
    await seed('rich', ['leopard', 'tree', 'sunset'], 'A leopard resting on a tree branch as the sun sets over the forest.', null);

    const response = await SELF.fetch('https://example.com/daily-pick');
    const body = await response.json();
    expect(body.photo.id).toBe('rich');
    expect(body.suggestedCaption).toBe('caption');
  });

  it('skips a photo suggested within the last 90 days if another is eligible', async () => {
    const recentlySuggested = new Date().toISOString();
    await seed('recent', ['leopard', 'tree', 'sunset'], 'A leopard resting on a tree branch as the sun sets.', recentlySuggested);
    await seed('eligible', ['leopard'], 'A leopard.', null);

    const response = await SELF.fetch('https://example.com/daily-pick');
    const body = await response.json();
    expect(body.photo.id).toBe('eligible');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `/daily-pick` route doesn't exist yet (404)

- [ ] **Step 3: Create `worker/src/routes/daily-pick.ts`**

```ts
import type { Context } from 'hono';
import type { Env } from '../types';

interface PhotoRow {
  id: string;
  subjects: string;
  description: string;
  season: string | null;
  environment: string | null;
  suggested_caption: string;
  suggested_hashtags: string;
  instagram_suggested: string | null;
  [key: string]: unknown;
}

const SEASON_MONTHS: Record<string, number[]> = {
  winter: [11, 0, 1],
  spring: [2, 3, 4],
  summer: [5, 6, 7],
  autumn: [8, 9, 10],
};

function isEligible(row: PhotoRow): boolean {
  if (!row.instagram_suggested) return true;
  const daysSince = (Date.now() - new Date(row.instagram_suggested).getTime()) / (1000 * 60 * 60 * 24);
  return daysSince > 90;
}

function score(row: PhotoRow): number {
  const subjects: string[] = JSON.parse(row.subjects);
  let s = subjects.length * 2;
  s += row.description.split(' ').filter(Boolean).length * 0.1;

  if (row.season) {
    const months = SEASON_MONTHS[row.season.toLowerCase()];
    if (months?.includes(new Date().getMonth())) {
      s += 5;
    }
  }
  return s;
}

export async function dailyPickRoute(c: Context<{ Bindings: Env }>) {
  const all = await c.env.DB.prepare('SELECT * FROM photos').all<PhotoRow>();
  if (all.results.length === 0) {
    return c.text('No photos available', 404);
  }

  const eligible = all.results.filter(isEligible);
  const pool = eligible.length > 0 ? eligible : all.results;

  const best = pool.reduce((a, b) => (score(b) > score(a) ? b : a));

  await c.env.DB.prepare('UPDATE photos SET instagram_suggested = ? WHERE id = ?')
    .bind(new Date().toISOString(), best.id)
    .run();

  const subjects: string[] = JSON.parse(best.subjects);
  const reason = `This photo was selected because it features ${
    subjects.length > 0 ? subjects.join(', ') : 'interesting subjects'
  } in a ${best.environment ?? 'natural'} setting${best.season ? ` during ${best.season}` : ''}.`;

  return c.json({
    photo: { ...best, subjects },
    reason,
    suggestedCaption: best.suggested_caption,
    suggestedHashtags: JSON.parse(best.suggested_hashtags),
  });
}
```

- [ ] **Step 4: Wire it into `worker/src/index.ts`**

```ts
import { dailyPickRoute } from './routes/daily-pick';
// ...
app.get('/daily-pick', dailyPickRoute);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add worker/src/routes/daily-pick.ts worker/src/index.ts worker/test/daily-pick.test.ts
git commit -m "Add GET /daily-pick using pre-generated captions/hashtags"
```

---

## After this plan

This Worker is deployable and fully testable on its own (`npm test` covers every route against real D1/R2 bindings). It has no dependency on the local agent or frontend. The next plans in sequence, per the spec:

1. **Local agent** — Ollama-backed `LLMService`, folder scanning, content hashing, thumbnail generation, calls into this Worker's `/ingest/*` endpoints.
2. **Google Drive folder-scoped indexing** — extends the local agent.
3. **Pages frontend** — calls `/search`, `/photos/:id`, `/albums`, `/daily-pick`, `/thumbnails/:contentHash`.
4. **Cloudflare Tunnel for originals** — exposes a local "serve original file" endpoint through `cloudflared`, scoped to already-indexed paths.

Each should be written as its own plan document when you're ready to start it, per the same process.
