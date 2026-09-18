# Local Agent (Ollama + Scanning + Dedup) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the local agent that scans local folders, dedups against the deployed Cloudflare backend, runs Ollama for vision analysis and text generation, generates thumbnails, and pushes everything to the Worker's ingest API. Google Drive folder-scoped indexing is a separate follow-on plan and is out of scope here — this plan only covers local-disk folders.

**Architecture:** A standalone Node/TypeScript CLI process (`agent/`), independent of the existing `src/` React app and Express server (neither is touched or deleted by this plan — see "What this plan does not touch" below). It talks to two things over HTTP: a local Ollama instance (vision + text generation) and the already-deployed `pixdex-worker` (ingest API, built in the prior phase). Every unit (hashing, scanning, EXIF, thumbnailing, Ollama calls, Cloudflare calls) is a small, independently testable module; `indexLocalFolder` is the orchestrator that wires them together and is the only piece with integration-style tests.

**Tech Stack:** Node.js (native `fetch`, native `crypto`), TypeScript, `sharp` (image processing/thumbnails, already a dependency elsewhere in this repo), `exifr` (EXIF date extraction — replaces the fragile hand-rolled regex date parsing in the old `PhotoIndexer`), `mime-types`, `zod` (config validation), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-18-pixdex-local-cloud-redesign-design.md`

**Depends on:** `docs/superpowers/plans/2026-09-18-pixdex-cloudflare-backend.md` (merged to `main`). This plan calls the real, deployed contract of that Worker as it exists today — verified against the current code in `worker/src/` rather than that plan's original draft, since a few details (thumbnail content-hash format validation, 409 on duplicate hash, request batch limits) were tightened during that phase's code review:

- `POST {base}/ingest/check-hashes` — body `{ hashes: string[] }` (server validates max 500 per call), returns `{ known: string[] }`. Requires `Authorization: Bearer <token>`.
- `POST {base}/ingest/photo` — body matches `ingestPhotoSchema` in `worker/src/db/photos.ts` (camelCase fields: `id`, `contentHash`, `source`, `path`, `driveFileId`, `filename`, `dateTime`, `width`, `height`, `format`, `fileSize`, `subjects`, `colors`, `patterns`, `tags`, `season`, `environment`, `album`, `description`, `suggestedCaption`, `suggestedHashtags`, `modelProvider`, `modelName`). Returns `201` on success, `409` if `contentHash` already exists under a different `id`. Requires the bearer token.
- `PUT {base}/ingest/thumbnail/:contentHash` — raw JPEG bytes as the body, `Content-Type: image/jpeg`. The Worker validates `contentHash` against `/^[A-Za-z0-9_-]{16,64}$/` and rejects bodies over 2MB (413). A lowercase-hex SHA-256 digest (64 chars) satisfies the pattern. Requires the bearer token.

## Global Constraints

- Original photos are never uploaded anywhere — only metadata (JSON payload) and a thumbnail (bytes, capped at 2MB by the Worker) ever leave local disk. (spec §1)
- Dedup check happens **before** any Ollama call — a file whose hash the Worker already knows must be skipped without being analyzed. (spec §4)
- The vision prompt must ask for both the specific subject and its broader category (e.g. "leopard" and "big cat") — this is mitigation #1 from spec §5 and is not optional.
- Every ingested photo must set `modelProvider` and `modelName`. (spec §4 amendment)
- A single bad file must not abort a folder's indexing run — catch, log, count as failed, continue. (spec §7)
- This plan does not implement Google Drive indexing, the frontend, or the Cloudflare Tunnel — those are separate plans.

---

## File Structure

```
agent/
  package.json
  tsconfig.json
  .env.example
  src/
    config.ts                  # loadConfig() — validates required env vars
    hashing.ts                 # sha256ContentHash()
    scanner.ts                 # isImageFile(), scanDirectory()
    exif.ts                    # extractExifData()
    thumbnail.ts               # generateThumbnail()
    cloudflareClient.ts        # CloudflareClient — check-hashes / ingest-photo / thumbnail upload
    ollama/
      client.ts                # OllamaClient — thin wrapper over Ollama's /api/chat
      analyzeImage.ts          # analyzeImage(), parseAnalysisResponse()
      generateText.ts          # generateText()
    indexLocalFolder.ts        # orchestrator
    cli.ts                     # `pixdex-agent index-local <folder>`
  test/
    config.test.ts
    hashing.test.ts
    scanner.test.ts
    exif.test.ts
    thumbnail.test.ts
    cloudflareClient.test.ts
    ollama-analyzeImage.test.ts
    ollama-generateText.test.ts
    indexLocalFolder.test.ts
    cli.test.ts
```

**What this plan does not touch:** `src/server/`, `src/services/llm/`, `src/services/indexer/`, `src/services/vectorstore/`, and the docker-compose Chroma service stay exactly as they are. They're superseded by this new `agent/` but are still what the *current* (pre-cutover) frontend depends on. Deleting them now would break the still-in-use old app before its replacement (the Pages frontend, a later plan) exists. Per spec §9, that deletion happens as part of the frontend cutover, in one shot, once nothing depends on the old code anymore.

---

### Task 1: Scaffold the agent project + config loader

**Files:**
- Create: `agent/package.json`
- Create: `agent/tsconfig.json`
- Create: `agent/.env.example`
- Create: `agent/src/config.ts`
- Test: `agent/test/config.test.ts`

**Interfaces:**
- Produces: `AgentConfig` type and `loadConfig(env?): AgentConfig` in `agent/src/config.ts` — every later task that talks to Ollama or Cloudflare consumes this.

- [ ] **Step 1: Create `agent/package.json`**

```json
{
  "name": "pixdex-agent",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "dev": "tsx src/cli.ts"
  },
  "dependencies": {
    "exifr": "^7.1.3",
    "mime-types": "^2.1.35",
    "sharp": "^0.33.2",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/mime-types": "^2.1.4",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `agent/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": ["node", "vitest/globals"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Create `agent/.env.example`**

```
CLOUDFLARE_API_BASE_URL=https://pixdex-worker.<your-subdomain>.workers.dev
INGEST_TOKEN=replace-with-the-same-value-as-the-worker-secret
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen3.5:27b-mlx
```

- [ ] **Step 4: Write the failing test — `agent/test/config.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('parses a valid environment', () => {
    const config = loadConfig({
      CLOUDFLARE_API_BASE_URL: 'https://example.workers.dev',
      INGEST_TOKEN: 'secret-token',
    });
    expect(config.CLOUDFLARE_API_BASE_URL).toBe('https://example.workers.dev');
    expect(config.INGEST_TOKEN).toBe('secret-token');
    expect(config.OLLAMA_BASE_URL).toBe('http://localhost:11434');
    expect(config.OLLAMA_MODEL).toBe('qwen3.5:27b-mlx');
  });

  it('throws when a required variable is missing', () => {
    expect(() => loadConfig({})).toThrow(/Invalid agent configuration/);
  });

  it('respects an explicit OLLAMA_MODEL override', () => {
    const config = loadConfig({
      CLOUDFLARE_API_BASE_URL: 'https://example.workers.dev',
      INGEST_TOKEN: 'secret-token',
      OLLAMA_MODEL: 'some-other-model',
    });
    expect(config.OLLAMA_MODEL).toBe('some-other-model');
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run (from `agent/`): `npm install && npm test`
Expected: FAIL — `src/config.ts` does not exist yet.

- [ ] **Step 6: Create `agent/src/config.ts`**

```ts
import { z } from 'zod';

const configSchema = z.object({
  CLOUDFLARE_API_BASE_URL: z.string().url(),
  INGEST_TOKEN: z.string().min(1),
  OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().min(1).default('qwen3.5:27b-mlx'),
});

export type AgentConfig = z.infer<typeof configSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): AgentConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid agent configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add agent/package.json agent/tsconfig.json agent/.env.example agent/src/config.ts agent/test/config.test.ts
git commit -m "Scaffold pixdex local agent with config loader"
```

---

### Task 2: Content hashing

**Files:**
- Create: `agent/src/hashing.ts`
- Test: `agent/test/hashing.test.ts`

**Interfaces:**
- Produces: `sha256ContentHash(filePath: string): Promise<string>` — returns a lowercase 64-char hex digest, consumed by `indexLocalFolder` (Task 9) as the dedup key and thumbnail-upload path segment.

- [ ] **Step 1: Write the failing test — `agent/test/hashing.test.ts`**

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256ContentHash } from '../src/hashing';

describe('sha256ContentHash', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pixdex-hash-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns a 64-char lowercase hex digest', async () => {
    const file = path.join(dir, 'a.txt');
    await writeFile(file, 'hello world');
    const hash = await sha256ContentHash(file);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic for identical content', async () => {
    const fileA = path.join(dir, 'a.txt');
    const fileB = path.join(dir, 'b.txt');
    await writeFile(fileA, 'same content');
    await writeFile(fileB, 'same content');
    expect(await sha256ContentHash(fileA)).toBe(await sha256ContentHash(fileB));
  });

  it('differs for different content', async () => {
    const fileA = path.join(dir, 'a.txt');
    const fileB = path.join(dir, 'b.txt');
    await writeFile(fileA, 'content one');
    await writeFile(fileB, 'content two');
    expect(await sha256ContentHash(fileA)).not.toBe(await sha256ContentHash(fileB));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/hashing.ts` does not exist yet.

- [ ] **Step 3: Create `agent/src/hashing.ts`**

```ts
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function sha256ContentHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/src/hashing.ts agent/test/hashing.test.ts
git commit -m "Add SHA-256 content hashing for dedup"
```

---

### Task 3: Folder scanning

**Files:**
- Create: `agent/src/scanner.ts`
- Test: `agent/test/scanner.test.ts`

**Interfaces:**
- Produces: `isImageFile(filename: string): boolean` and `scanDirectory(dir: string): Promise<string[]>` (recursive, returns absolute file paths), consumed by `indexLocalFolder` (Task 9).

- [ ] **Step 1: Write the failing test — `agent/test/scanner.test.ts`**

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isImageFile, scanDirectory } from '../src/scanner';

describe('isImageFile', () => {
  it('accepts common image extensions', () => {
    expect(isImageFile('leopard.jpg')).toBe(true);
    expect(isImageFile('leopard.PNG')).toBe(true);
  });

  it('rejects non-image files', () => {
    expect(isImageFile('notes.txt')).toBe(false);
  });

  it('rejects macOS resource-fork files', () => {
    expect(isImageFile('._leopard.jpg')).toBe(false);
  });
});

describe('scanDirectory', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pixdex-scan-'));
    await mkdir(path.join(dir, 'sub'));
    await writeFile(path.join(dir, 'a.jpg'), 'x');
    await writeFile(path.join(dir, 'notes.txt'), 'x');
    await writeFile(path.join(dir, 'sub', 'b.png'), 'x');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds files recursively, including nested folders', async () => {
    const files = await scanDirectory(dir);
    expect(files).toHaveLength(3);
    expect(files.some((f) => f.endsWith('sub/b.png'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/scanner.ts` does not exist yet.

- [ ] **Step 3: Create `agent/src/scanner.ts`**

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import mime from 'mime-types';

export function isImageFile(filename: string): boolean {
  const basename = path.basename(filename);
  if (basename.startsWith('._')) {
    return false;
  }
  const mimeType = mime.lookup(filename);
  return mimeType ? mimeType.startsWith('image/') : false;
}

export async function scanDirectory(dir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentDir: string) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        files.push(fullPath);
      }
    }
  }

  await walk(dir);
  return files;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/src/scanner.ts agent/test/scanner.test.ts
git commit -m "Add local folder scanning and image-file filtering"
```

---

### Task 4: EXIF extraction

**Files:**
- Create: `agent/src/exif.ts`
- Test: `agent/test/exif.test.ts`

**Interfaces:**
- Produces: `PhotoExifData` type and `extractExifData(filePath: string): Promise<PhotoExifData>` (`{ dateTime?: string; dimensions: { width: number; height: number }; format?: string; size?: number; space?: string; hasAlpha?: boolean; channels?: number }`), consumed by `indexLocalFolder` (Task 9).

- [ ] **Step 1: Write the failing test — `agent/test/exif.test.ts`**

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractExifData } from '../src/exif';

describe('extractExifData', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pixdex-exif-'));
    filePath = path.join(dir, 'fixture.jpg');
    await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 100, g: 150, b: 80 } },
    })
      .jpeg()
      .toFile(filePath);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads dimensions and format from an image with no EXIF data', async () => {
    const result = await extractExifData(filePath);
    expect(result.dimensions).toEqual({ width: 800, height: 600 });
    expect(result.format).toBe('jpeg');
    expect(result.dateTime).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/exif.ts` does not exist yet.

- [ ] **Step 3: Create `agent/src/exif.ts`**

```ts
import exifr from 'exifr';
import sharp from 'sharp';

export interface PhotoExifData {
  dateTime?: string;
  dimensions: { width: number; height: number };
  format?: string;
  size?: number;
  space?: string;
  hasAlpha?: boolean;
  channels?: number;
}

export async function extractExifData(filePath: string): Promise<PhotoExifData> {
  const metadata = await sharp(filePath).metadata();

  let dateTime: string | undefined;
  try {
    const parsed = await exifr.parse(filePath, ['DateTimeOriginal', 'CreateDate']);
    const raw = parsed?.DateTimeOriginal ?? parsed?.CreateDate;
    if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
      dateTime = raw.toISOString();
    }
  } catch {
    // No readable EXIF — dateTime stays undefined; caller may fall back to filesystem mtime.
  }

  return {
    dateTime,
    dimensions: { width: metadata.width ?? 0, height: metadata.height ?? 0 },
    format: metadata.format,
    size: metadata.size,
    space: metadata.space,
    hasAlpha: metadata.hasAlpha,
    channels: metadata.channels,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/src/exif.ts agent/test/exif.test.ts
git commit -m "Add EXIF/metadata extraction via sharp + exifr"
```

---

### Task 5: Thumbnail generation

**Files:**
- Create: `agent/src/thumbnail.ts`
- Test: `agent/test/thumbnail.test.ts`

**Interfaces:**
- Produces: `generateThumbnail(filePath: string): Promise<Buffer>` — a JPEG buffer, max 400px on the long edge, quality 80. Consumed by `indexLocalFolder` (Task 9) and uploaded via `CloudflareClient.uploadThumbnail` (Task 6). Must stay under the Worker's 2MB thumbnail limit (`worker/src/routes/ingest-thumbnail.ts`).

- [ ] **Step 1: Write the failing test — `agent/test/thumbnail.test.ts`**

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateThumbnail } from '../src/thumbnail';

const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024; // matches worker/src/routes/ingest-thumbnail.ts

describe('generateThumbnail', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pixdex-thumb-'));
    filePath = path.join(dir, 'fixture.jpg');
    await sharp({
      create: { width: 2000, height: 1500, channels: 3, background: { r: 20, g: 120, b: 60 } },
    })
      .jpeg()
      .toFile(filePath);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('produces a JPEG no larger than 400px on the long edge', async () => {
    const buffer = await generateThumbnail(filePath);
    const metadata = await sharp(buffer).metadata();
    expect(metadata.format).toBe('jpeg');
    expect(metadata.width).toBeLessThanOrEqual(400);
    expect(metadata.height).toBeLessThanOrEqual(400);
  });

  it('stays under the Worker thumbnail size limit', async () => {
    const buffer = await generateThumbnail(filePath);
    expect(buffer.byteLength).toBeLessThan(MAX_THUMBNAIL_BYTES);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/thumbnail.ts` does not exist yet.

- [ ] **Step 3: Create `agent/src/thumbnail.ts`**

```ts
import sharp from 'sharp';

const THUMBNAIL_MAX_DIMENSION = 400;
const THUMBNAIL_JPEG_QUALITY = 80;

export async function generateThumbnail(filePath: string): Promise<Buffer> {
  return sharp(filePath)
    .resize(THUMBNAIL_MAX_DIMENSION, THUMBNAIL_MAX_DIMENSION, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: THUMBNAIL_JPEG_QUALITY })
    .toBuffer();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/src/thumbnail.ts agent/test/thumbnail.test.ts
git commit -m "Add thumbnail generation via sharp"
```

---

### Task 6: Cloudflare ingest client

**Files:**
- Create: `agent/src/cloudflareClient.ts`
- Test: `agent/test/cloudflareClient.test.ts`

**Interfaces:**
- Consumes: `AgentConfig` (Task 1).
- Produces: `CloudflareClient` class with `checkHashes(hashes: string[]): Promise<Set<string>>`, `ingestPhoto(payload: IngestPhotoPayload): Promise<void>`, `uploadThumbnail(contentHash: string, bytes: Buffer): Promise<void>`. `IngestPhotoPayload` is the exact camelCase shape `worker/src/db/photos.ts`'s `ingestPhotoSchema` expects. Consumed by `indexLocalFolder` (Task 9).

- [ ] **Step 1: Write the failing test — `agent/test/cloudflareClient.test.ts`**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudflareClient, type IngestPhotoPayload } from '../src/cloudflareClient';
import type { AgentConfig } from '../src/config';

const config: AgentConfig = {
  CLOUDFLARE_API_BASE_URL: 'https://example.workers.dev',
  INGEST_TOKEN: 'secret-token',
  OLLAMA_BASE_URL: 'http://localhost:11434',
  OLLAMA_MODEL: 'qwen3.5:27b-mlx',
};

describe('CloudflareClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: CloudflareClient;

  beforeEach(() => {
    fetchMock = vi.fn();
    client = new CloudflareClient(config, fetchMock as unknown as typeof fetch);
  });

  it('checkHashes posts to /ingest/check-hashes with the bearer token', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ known: ['h1'] }), { status: 200 })
    );

    const known = await client.checkHashes(['h1', 'h2']);

    expect(known).toEqual(new Set(['h1']));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.workers.dev/ingest/check-hashes');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer secret-token');
    expect(JSON.parse(init.body)).toEqual({ hashes: ['h1', 'h2'] });
  });

  it('checkHashes batches requests in chunks of 500', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ known: [] }), { status: 200 }));
    const hashes = Array.from({ length: 600 }, (_, i) => `hash-${i}`);

    await client.checkHashes(hashes);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).hashes).toHaveLength(500);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).hashes).toHaveLength(100);
  });

  it('ingestPhoto posts the payload and resolves on 201', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 201 }));
    const payload: IngestPhotoPayload = {
      id: 'photo-1',
      contentHash: 'a'.repeat(64),
      source: 'local',
      filename: 'a.jpg',
      subjects: ['leopard'],
      colors: [],
      patterns: [],
      tags: ['leopard', 'big cat'],
      description: 'desc',
      suggestedCaption: 'caption',
      suggestedHashtags: ['leopard'],
      modelProvider: 'ollama',
      modelName: 'qwen3.5:27b-mlx',
    };

    await expect(client.ingestPhoto(payload)).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.workers.dev/ingest/photo');
    expect(JSON.parse(init.body).contentHash).toBe('a'.repeat(64));
  });

  it('ingestPhoto throws on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 409 }));
    await expect(
      client.ingestPhoto({
        id: 'x',
        contentHash: 'a'.repeat(64),
        source: 'local',
        filename: 'a.jpg',
        subjects: [],
        colors: [],
        patterns: [],
        tags: [],
        description: '',
        suggestedCaption: '',
        suggestedHashtags: [],
        modelProvider: 'ollama',
        modelName: 'qwen3.5:27b-mlx',
      })
    ).rejects.toThrow(/ingest\/photo failed: 409/);
  });

  it('uploadThumbnail PUTs raw bytes with an image/jpeg content type', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 201 }));
    const bytes = Buffer.from([1, 2, 3]);

    await client.uploadThumbnail('a'.repeat(64), bytes);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://example.workers.dev/ingest/thumbnail/${'a'.repeat(64)}`);
    expect(init.method).toBe('PUT');
    expect(init.headers['Content-Type']).toBe('image/jpeg');
    expect(init.body).toBe(bytes);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/cloudflareClient.ts` does not exist yet.

- [ ] **Step 3: Create `agent/src/cloudflareClient.ts`**

```ts
import type { AgentConfig } from './config';

const CHECK_HASHES_BATCH_SIZE = 500;

export interface IngestPhotoPayload {
  id: string;
  contentHash: string;
  source: 'local' | 'google_drive';
  path?: string;
  driveFileId?: string;
  filename: string;
  dateTime?: string;
  width?: number;
  height?: number;
  format?: string;
  fileSize?: number;
  subjects: string[];
  colors: string[];
  patterns: string[];
  tags: string[];
  season?: string;
  environment?: string;
  album?: string;
  description: string;
  suggestedCaption: string;
  suggestedHashtags: string[];
  modelProvider: string;
  modelName: string;
}

export class CloudflareClient {
  constructor(
    private config: AgentConfig,
    private fetchFn: typeof fetch = fetch
  ) {}

  private authHeaders(contentType: string): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.INGEST_TOKEN}`,
      'Content-Type': contentType,
    };
  }

  async checkHashes(hashes: string[]): Promise<Set<string>> {
    const known = new Set<string>();

    for (let i = 0; i < hashes.length; i += CHECK_HASHES_BATCH_SIZE) {
      const batch = hashes.slice(i, i + CHECK_HASHES_BATCH_SIZE);
      const response = await this.fetchFn(`${this.config.CLOUDFLARE_API_BASE_URL}/ingest/check-hashes`, {
        method: 'POST',
        headers: this.authHeaders('application/json'),
        body: JSON.stringify({ hashes: batch }),
      });
      if (!response.ok) {
        throw new Error(`check-hashes failed: ${response.status}`);
      }
      const body = (await response.json()) as { known: string[] };
      body.known.forEach((h) => known.add(h));
    }

    return known;
  }

  async ingestPhoto(payload: IngestPhotoPayload): Promise<void> {
    const response = await this.fetchFn(`${this.config.CLOUDFLARE_API_BASE_URL}/ingest/photo`, {
      method: 'POST',
      headers: this.authHeaders('application/json'),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`ingest/photo failed: ${response.status}`);
    }
  }

  async uploadThumbnail(contentHash: string, bytes: Buffer): Promise<void> {
    const response = await this.fetchFn(
      `${this.config.CLOUDFLARE_API_BASE_URL}/ingest/thumbnail/${contentHash}`,
      {
        method: 'PUT',
        headers: this.authHeaders('image/jpeg'),
        body: bytes,
      }
    );
    if (!response.ok) {
      throw new Error(`ingest/thumbnail failed: ${response.status}`);
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/src/cloudflareClient.ts agent/test/cloudflareClient.test.ts
git commit -m "Add Cloudflare ingest API client (check-hashes, photo, thumbnail)"
```

---

### Task 7: Ollama client + vision analysis

**Files:**
- Create: `agent/src/ollama/client.ts`
- Create: `agent/src/ollama/analyzeImage.ts`
- Test: `agent/test/ollama-analyzeImage.test.ts`

**Interfaces:**
- Consumes: `AgentConfig` (Task 1).
- Produces: `OllamaClient` class with `chat(messages: OllamaMessage[]): Promise<string>`, consumed by both this task and Task 8. Produces `ImageAnalysisResult` type and `analyzeImage(imagePath: string, client: OllamaClient): Promise<ImageAnalysisResult>` plus the exported `parseAnalysisResponse(content: string): ImageAnalysisResult` for direct unit testing, consumed by `indexLocalFolder` (Task 9).

- [ ] **Step 1: Write the failing test — `agent/test/ollama-analyzeImage.test.ts`**

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeImage, parseAnalysisResponse } from '../src/ollama/analyzeImage';
import { OllamaClient } from '../src/ollama/client';

const SAMPLE_RESPONSE = `SUBJECTS: leopard, big cat

COLORS: gold, green

PATTERNS: spots

SEASON: winter

ENVIRONMENT: dense forest

TAGS: leopard, big cat, forest, tree

DESCRIPTION: A leopard resting on a tree branch at dusk.`;

describe('parseAnalysisResponse', () => {
  it('parses structured sections into an ImageAnalysisResult', () => {
    const result = parseAnalysisResponse(SAMPLE_RESPONSE);
    expect(result.subjects).toEqual(['leopard', 'big cat']);
    expect(result.tags).toContain('big cat');
    expect(result.season).toBe('winter');
    expect(result.description).toBe('A leopard resting on a tree branch at dusk.');
  });

  it('falls back to defaults for missing sections', () => {
    const result = parseAnalysisResponse('DESCRIPTION: just a photo.');
    expect(result.subjects).toEqual(['Unknown']);
    expect(result.colors).toEqual(['Not specified']);
  });
});

describe('analyzeImage', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pixdex-analyze-'));
    filePath = path.join(dir, 'fixture.jpg');
    await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .jpeg()
      .toFile(filePath);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('sends a prompt asking for broader-category tags and parses the reply', async () => {
    const chat = vi.fn().mockResolvedValue(SAMPLE_RESPONSE);
    const client = { chat } as unknown as OllamaClient;

    const result = await analyzeImage(filePath, client);

    expect(result.subjects).toEqual(['leopard', 'big cat']);
    const [messages] = chat.mock.calls[0];
    const userMessage = messages.find((m: { role: string }) => m.role === 'user');
    expect(userMessage.content).toMatch(/broader category/i);
    expect(userMessage.images).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/ollama/client.ts` and `src/ollama/analyzeImage.ts` don't exist yet.

- [ ] **Step 3: Create `agent/src/ollama/client.ts`**

```ts
import type { AgentConfig } from '../config';

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  images?: string[];
}

export class OllamaClient {
  constructor(
    private config: AgentConfig,
    private fetchFn: typeof fetch = fetch
  ) {}

  async chat(messages: OllamaMessage[]): Promise<string> {
    const response = await this.fetchFn(`${this.config.OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.config.OLLAMA_MODEL, messages, stream: false }),
    });
    if (!response.ok) {
      throw new Error(`Ollama chat failed: ${response.status}`);
    }
    const body = (await response.json()) as { message: { content: string } };
    return body.message.content;
  }
}
```

- [ ] **Step 4: Create `agent/src/ollama/analyzeImage.ts`**

```ts
import fs from 'node:fs/promises';
import type { OllamaClient } from './client';

export interface ImageAnalysisResult {
  subjects: string[];
  colors: string[];
  patterns: string[];
  season?: string;
  environment?: string;
  description: string;
  tags: string[];
}

const ANALYSIS_PROMPT = `Analyze this wildlife photo and provide the following information in a structured format:
1. SUBJECTS: List all animals/wildlife subjects visible in the image. For each specific species, also include its broader category (e.g. "leopard" and "big cat"; "osprey" and "raptor"; "monitor lizard" and "reptile") so both the specific and general terms are searchable.
2. COLORS: List dominant colors in the image
3. PATTERNS: Describe any notable patterns or textures
4. SEASON: If apparent from the environment or context. Indian seasons.
5. ENVIRONMENT: Detailed description of the habitat/setting
6. TAGS: Relevant keywords for searching (max 15), including both specific and broader-category terms
7. DESCRIPTION: A detailed, professional description of the photo

Format each section clearly with headings.`;

export async function analyzeImage(imagePath: string, client: OllamaClient): Promise<ImageAnalysisResult> {
  const bytes = await fs.readFile(imagePath);
  const base64Image = bytes.toString('base64');

  const content = await client.chat([
    {
      role: 'system',
      content:
        'You are a wildlife photography expert tasked with analyzing photos (mostly from India). Provide detailed, accurate information about the wildlife, environment, and photographic elements in each image.',
    },
    { role: 'user', content: ANALYSIS_PROMPT, images: [base64Image] },
  ]);

  return parseAnalysisResponse(content);
}

export function parseAnalysisResponse(content: string): ImageAnalysisResult {
  const sections = content.split(/\n\s*\n/);
  const result: ImageAnalysisResult = {
    subjects: [],
    colors: [],
    patterns: [],
    season: undefined,
    environment: undefined,
    description: '',
    tags: [],
  };

  for (const section of sections) {
    const [heading, ...rest] = section.split('\n').map((s) => s.trim());
    const body = rest.join(' ').trim();

    if (/SUBJECTS?:/i.test(heading)) result.subjects = splitList(body);
    else if (/COLORS?:/i.test(heading)) result.colors = splitList(body);
    else if (/PATTERNS?:/i.test(heading)) result.patterns = splitList(body);
    else if (/SEASON:/i.test(heading)) result.season = body || undefined;
    else if (/ENVIRONMENT:/i.test(heading)) result.environment = body || undefined;
    else if (/TAGS?:/i.test(heading)) result.tags = splitList(body);
    else if (/DESCRIPTION:/i.test(heading)) result.description = body;
  }

  result.subjects = result.subjects.length ? result.subjects : ['Unknown'];
  result.colors = result.colors.length ? result.colors : ['Not specified'];
  result.patterns = result.patterns.length ? result.patterns : ['None detected'];
  result.tags = result.tags.length ? result.tags : [...result.subjects];
  result.description = result.description || 'No description available';
  result.environment = result.environment || 'Unknown environment';

  return result;
}

function splitList(body: string): string[] {
  return body
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add agent/src/ollama/client.ts agent/src/ollama/analyzeImage.ts agent/test/ollama-analyzeImage.test.ts
git commit -m "Add Ollama client and vision analysis with broader-category tag prompt"
```

---

### Task 8: Ollama text generation

**Files:**
- Create: `agent/src/ollama/generateText.ts`
- Test: `agent/test/ollama-generateText.test.ts`

**Interfaces:**
- Consumes: `OllamaClient` (Task 7).
- Produces: `generateText(prompt: string, client: OllamaClient): Promise<string>`, consumed by `indexLocalFolder` (Task 9) for captions and hashtags.

- [ ] **Step 1: Write the failing test — `agent/test/ollama-generateText.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest';
import { generateText } from '../src/ollama/generateText';
import type { OllamaClient } from '../src/ollama/client';

describe('generateText', () => {
  it('sends the prompt and returns trimmed content', async () => {
    const chat = vi.fn().mockResolvedValue('  Golden hour, golden coat.  \n');
    const client = { chat } as unknown as OllamaClient;

    const result = await generateText('Write a caption', client);

    expect(result).toBe('Golden hour, golden coat.');
    const [messages] = chat.mock.calls[0];
    expect(messages.some((m: { role: string }) => m.role === 'system')).toBe(true);
    expect(messages.find((m: { role: string }) => m.role === 'user').content).toBe('Write a caption');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/ollama/generateText.ts` does not exist yet.

- [ ] **Step 3: Create `agent/src/ollama/generateText.ts`**

```ts
import type { OllamaClient } from './client';

export async function generateText(prompt: string, client: OllamaClient): Promise<string> {
  const content = await client.chat([
    {
      role: 'system',
      content: 'You are a wildlife photography expert writing engaging, accurate Instagram content.',
    },
    { role: 'user', content: prompt },
  ]);
  return content.trim();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/src/ollama/generateText.ts agent/test/ollama-generateText.test.ts
git commit -m "Add Ollama text generation for captions/hashtags"
```

---

### Task 9: `indexLocalFolder` orchestrator

**Files:**
- Create: `agent/src/indexLocalFolder.ts`
- Test: `agent/test/indexLocalFolder.test.ts`

**Interfaces:**
- Consumes: `scanDirectory`/`isImageFile` (Task 3), `sha256ContentHash` (Task 2), `extractExifData` (Task 4), `generateThumbnail` (Task 5), `analyzeImage` (Task 7), `generateText` (Task 8), `CloudflareClient`/`IngestPhotoPayload` (Task 6), `OllamaClient` (Task 7), `AgentConfig` (Task 1).
- Produces: `IndexLocalFolderResult` (`{ total, indexed, skipped, failed }`) and `indexLocalFolder(folder: string, deps: IndexLocalFolderDeps): Promise<IndexLocalFolderResult>`, consumed by `cli.ts` (Task 10).

- [ ] **Step 1: Write the failing test — `agent/test/indexLocalFolder.test.ts`**

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256ContentHash } from '../src/hashing';
import { indexLocalFolder } from '../src/indexLocalFolder';
import type { AgentConfig } from '../src/config';

const SAMPLE_RESPONSE = `SUBJECTS: leopard, big cat

COLORS: gold

PATTERNS: spots

SEASON: winter

ENVIRONMENT: forest

TAGS: leopard, big cat

DESCRIPTION: A leopard in a tree.`;

const config: AgentConfig = {
  CLOUDFLARE_API_BASE_URL: 'https://example.workers.dev',
  INGEST_TOKEN: 'secret-token',
  OLLAMA_BASE_URL: 'http://localhost:11434',
  OLLAMA_MODEL: 'qwen3.5:27b-mlx',
};

describe('indexLocalFolder', () => {
  let dir: string;
  let knownFile: string;
  let newFile: string;
  let failingFile: string;
  let knownHash: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pixdex-index-'));
    knownFile = path.join(dir, 'known.jpg');
    newFile = path.join(dir, 'new.jpg');
    failingFile = path.join(dir, 'failing.jpg');

    for (const file of [knownFile, newFile, failingFile]) {
      await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 1, g: 2, b: 3 } } })
        .jpeg()
        .toFile(file);
    }
    knownHash = await sha256ContentHash(knownFile);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('skips already-known hashes, indexes new files, and counts failures without aborting', async () => {
    const cloudflareClient = {
      checkHashes: vi.fn().mockResolvedValue(new Set([knownHash])),
      ingestPhoto: vi.fn().mockImplementation((payload: { path?: string }) => {
        if (payload.path === failingFile) {
          return Promise.reject(new Error('simulated ingest failure'));
        }
        return Promise.resolve();
      }),
      uploadThumbnail: vi.fn().mockResolvedValue(undefined),
    };
    const ollamaClient = {
      chat: vi.fn().mockResolvedValue(SAMPLE_RESPONSE),
    };

    const result = await indexLocalFolder(dir, {
      cloudflareClient: cloudflareClient as any,
      ollamaClient: ollamaClient as any,
      config,
    });

    expect(result).toEqual({ total: 3, indexed: 1, skipped: 1, failed: 1 });
    expect(cloudflareClient.ingestPhoto).toHaveBeenCalledTimes(2); // new.jpg + failing.jpg (which then rejects)
    expect(cloudflareClient.uploadThumbnail).toHaveBeenCalledTimes(1); // only for new.jpg, since failing.jpg's ingestPhoto rejected first

    const newFilePayload = cloudflareClient.ingestPhoto.mock.calls.find(
      ([payload]: [{ path?: string }]) => payload.path === newFile
    )[0];
    expect(newFilePayload.modelProvider).toBe('ollama');
    expect(newFilePayload.modelName).toBe('qwen3.5:27b-mlx');
    expect(newFilePayload.subjects).toEqual(['leopard', 'big cat']);
    expect(newFilePayload.suggestedCaption).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/indexLocalFolder.ts` does not exist yet.

- [ ] **Step 3: Create `agent/src/indexLocalFolder.ts`**

```ts
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isImageFile, scanDirectory } from './scanner';
import { sha256ContentHash } from './hashing';
import { extractExifData } from './exif';
import { generateThumbnail } from './thumbnail';
import { analyzeImage, type ImageAnalysisResult } from './ollama/analyzeImage';
import { generateText } from './ollama/generateText';
import type { OllamaClient } from './ollama/client';
import { CloudflareClient, type IngestPhotoPayload } from './cloudflareClient';
import type { AgentConfig } from './config';

export interface IndexLocalFolderResult {
  total: number;
  indexed: number;
  skipped: number;
  failed: number;
}

export interface IndexLocalFolderDeps {
  cloudflareClient: CloudflareClient;
  ollamaClient: OllamaClient;
  config: AgentConfig;
  onProgress?: (message: string) => void;
}

export async function indexLocalFolder(
  folder: string,
  deps: IndexLocalFolderDeps
): Promise<IndexLocalFolderResult> {
  const { cloudflareClient, ollamaClient, config, onProgress } = deps;

  const allFiles = await scanDirectory(folder);
  const imageFiles = allFiles.filter(isImageFile);
  const hashes = await Promise.all(imageFiles.map((file) => sha256ContentHash(file)));
  const knownHashes = await cloudflareClient.checkHashes(hashes);

  let indexed = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < imageFiles.length; i++) {
    const file = imageFiles[i];
    const contentHash = hashes[i];

    if (knownHashes.has(contentHash)) {
      skipped++;
      onProgress?.(`Skipping already-indexed: ${file}`);
      continue;
    }

    try {
      const exif = await extractExifData(file);
      const analysis = await analyzeImage(file, ollamaClient);
      const caption = await generateText(buildCaptionPrompt(analysis), ollamaClient);
      const hashtags = await generateText(buildHashtagPrompt(analysis), ollamaClient);
      const thumbnail = await generateThumbnail(file);

      const payload: IngestPhotoPayload = {
        id: randomUUID(),
        contentHash,
        source: 'local',
        path: file,
        filename: path.basename(file),
        dateTime: exif.dateTime,
        width: exif.dimensions.width,
        height: exif.dimensions.height,
        format: exif.format,
        fileSize: exif.size,
        subjects: analysis.subjects,
        colors: analysis.colors,
        patterns: analysis.patterns,
        tags: analysis.tags,
        season: analysis.season,
        environment: analysis.environment,
        description: analysis.description,
        suggestedCaption: caption,
        suggestedHashtags: parseHashtagList(hashtags),
        modelProvider: 'ollama',
        modelName: config.OLLAMA_MODEL,
      };

      await cloudflareClient.ingestPhoto(payload);
      await cloudflareClient.uploadThumbnail(contentHash, thumbnail);
      indexed++;
      onProgress?.(`Indexed: ${file}`);
    } catch (error) {
      failed++;
      onProgress?.(`Failed: ${file} (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  return { total: imageFiles.length, indexed, skipped, failed };
}

function buildCaptionPrompt(analysis: ImageAnalysisResult): string {
  return `Generate an engaging Instagram caption for this wildlife photo using these details:
Subject: ${analysis.subjects.join(', ')}
Environment: ${analysis.environment ?? 'Not specified'}
Description: ${analysis.description}
Season: ${analysis.season ?? 'Not specified'}

Make it engaging, informative, include an interesting fact, end with a question, and keep it under 200 characters.`;
}

function buildHashtagPrompt(analysis: ImageAnalysisResult): string {
  return `Generate up to 15 relevant Instagram hashtags for this wildlife photo, comma-separated, no # symbol:
Subjects: ${analysis.subjects.join(', ')}
Environment: ${analysis.environment ?? 'Not specified'}
Colors: ${analysis.colors.join(', ')}
Season: ${analysis.season ?? 'Not specified'}`;
}

function parseHashtagList(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((tag) => tag.trim().replace(/[^a-zA-Z0-9_]/g, ''))
    .filter((tag) => tag.length > 0 && tag.length <= 30);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/src/indexLocalFolder.ts agent/test/indexLocalFolder.test.ts
git commit -m "Add indexLocalFolder orchestrator: scan, dedup, analyze, ingest"
```

---

### Task 10: CLI entrypoint

**Files:**
- Create: `agent/src/cli.ts`
- Test: `agent/test/cli.test.ts`

**Interfaces:**
- Consumes: `loadConfig` (Task 1), `CloudflareClient` (Task 6), `OllamaClient` (Task 7), `indexLocalFolder` (Task 9).
- Produces: `runCli(argv: string[]): Promise<number>` (exit code), and a `pixdex-agent index-local <folder>` command when run directly via `tsx src/cli.ts index-local <folder>`.

- [ ] **Step 1: Write the failing test — `agent/test/cli.test.ts`**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadConfigMock = vi.fn();
const indexLocalFolderMock = vi.fn();

vi.mock('../src/config', () => ({ loadConfig: loadConfigMock }));
vi.mock('../src/indexLocalFolder', () => ({ indexLocalFolder: indexLocalFolderMock }));
vi.mock('../src/cloudflareClient', () => ({ CloudflareClient: vi.fn() }));
vi.mock('../src/ollama/client', () => ({ OllamaClient: vi.fn() }));

const { runCli } = await import('../src/cli');

describe('runCli', () => {
  beforeEach(() => {
    loadConfigMock.mockReset().mockReturnValue({
      CLOUDFLARE_API_BASE_URL: 'https://example.workers.dev',
      INGEST_TOKEN: 'secret-token',
      OLLAMA_BASE_URL: 'http://localhost:11434',
      OLLAMA_MODEL: 'qwen3.5:27b-mlx',
    });
    indexLocalFolderMock.mockReset().mockResolvedValue({ total: 1, indexed: 1, skipped: 0, failed: 0 });
  });

  it('runs indexLocalFolder for "index-local <folder>" and returns 0', async () => {
    const code = await runCli(['index-local', '/tmp/photos']);
    expect(code).toBe(0);
    expect(indexLocalFolderMock).toHaveBeenCalledWith('/tmp/photos', expect.any(Object));
  });

  it('returns 1 and does not run indexing when the folder argument is missing', async () => {
    const code = await runCli(['index-local']);
    expect(code).toBe(1);
    expect(indexLocalFolderMock).not.toHaveBeenCalled();
  });

  it('returns 1 for an unknown command', async () => {
    const code = await runCli(['bogus-command', '/tmp/photos']);
    expect(code).toBe(1);
    expect(indexLocalFolderMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/cli.ts` does not exist yet.

- [ ] **Step 3: Create `agent/src/cli.ts`**

```ts
import { loadConfig } from './config';
import { CloudflareClient } from './cloudflareClient';
import { OllamaClient } from './ollama/client';
import { indexLocalFolder } from './indexLocalFolder';

export async function runCli(argv: string[]): Promise<number> {
  const [command, folder] = argv;

  if (command !== 'index-local' || !folder) {
    console.error('Usage: pixdex-agent index-local <folder>');
    return 1;
  }

  const config = loadConfig();
  const cloudflareClient = new CloudflareClient(config);
  const ollamaClient = new OllamaClient(config);

  const result = await indexLocalFolder(folder, {
    cloudflareClient,
    ollamaClient,
    config,
    onProgress: (message) => console.log(message),
  });

  console.log(
    `Done. Total: ${result.total}, Indexed: ${result.indexed}, Skipped: ${result.skipped}, Failed: ${result.failed}`
  );
  return 0;
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/src/cli.ts agent/test/cli.test.ts
git commit -m "Add pixdex-agent CLI: index-local command"
```

---

## After this plan

The local agent can now index local folders end-to-end against the deployed Worker, with dedup, broader-category tagging, and pre-generated captions/hashtags, one file failure never blocking the rest of the batch. Remaining plans, per the spec:

1. **Google Drive folder-scoped indexing** — extends `agent/` with a Drive folder picker and a Drive-sourced variant of the `indexLocalFolder` pipeline (same downstream steps, different file listing/download source).
2. **Pages frontend** — calls the Worker's `/search`, `/photos/:id`, `/albums`, `/daily-pick`, `/thumbnails/:contentHash`; this is also where the old `src/server`, `src/services/llm`, `src/services/indexer`, `src/services/vectorstore`, and the Chroma docker-compose service get deleted in one shot, once the new frontend no longer needs them.
3. **Cloudflare Tunnel for originals** — a small addition to `agent/` that serves already-indexed local-disk originals over `cloudflared`, scoped to indexed paths only.
