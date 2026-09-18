# Google Drive Folder-Scoped Indexing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the local agent index photos from user-picked Google Drive folders, one time, on demand — no continuous sync, no whole-Drive scanning (today's untested `PhotoIndexer.indexGoogleDrivePhotos` in the old app does the latter and is being replaced, not extended).

**Architecture:** Extends `agent/` (built in the prior phase, merged to `main`) with a Google OAuth flow (loopback redirect, refresh token persisted locally), a thin Drive Files API wrapper, and a Drive-sourced indexing orchestrator that reuses the exact same per-file pipeline (EXIF → Ollama analysis → captions/hashtags → thumbnail → ingest) as local indexing — extracted into a shared `processFile` module in Task 1 so the two orchestrators don't duplicate that logic. Because Drive files must be downloaded to compute their content hash (the same dedup key used for local files), each file is downloaded, hashed, dedup-checked, processed, and deleted one at a time — never more than one Drive original on local disk at once.

**Tech Stack:** `googleapis` (Drive API v3 + OAuth2 client), Node's built-in `node:http` (loopback OAuth redirect) and `node:readline/promises` (interactive folder picker), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-18-pixdex-local-cloud-redesign-design.md`

**Depends on:** `docs/superpowers/plans/2026-09-18-pixdex-local-agent.md` (merged to `main`). This plan extends the real, current `agent/` code:
- `IngestPhotoPayload` (`agent/src/cloudflareClient.ts`) already has `source: 'local' | 'google_drive'` and an optional `driveFileId` field — no change needed there.
- `indexLocalFolder` (`agent/src/indexLocalFolder.ts`) uploads the thumbnail **before** calling `ingestPhoto` (a review fix from Phase 2: `ingestPhoto` succeeding is what makes a file's hash "known" on future dedup checks, so the thumbnail must land first). The Drive orchestrator must follow the same ordering.
- `CloudflareClient.checkHashes` batches in groups of 500 and is safe to call with a single hash.

## Global Constraints

- One-time, folder-scoped indexing only. No folder watching, no incremental sync, no "list every image in the whole Drive." (spec §6, "out of scope")
- Original Drive files are downloaded to a local temp path only for the duration of processing a single file, then deleted immediately — never persisted, never batch-predownloaded. (spec §1 storage constraint + "avoid duplicate work/storage" motivation)
- Dedup uses the same `content_hash` mechanism as local files, via the same `POST /ingest/check-hashes` endpoint — a photo already indexed from local disk (or a prior Drive run) is skipped even if it now appears in a newly-picked Drive folder.
- OAuth tokens are never committed to git.
- A single file's download/analysis/ingest failure must not abort the rest of the folder. (spec §7, same rule as local indexing)

---

## File Structure

```
agent/
  .gitignore                          # new — ignores the persisted OAuth token
  src/
    processFile.ts                    # new — extracted shared per-file pipeline
    indexLocalFolder.ts               # modified — now calls processFile
    google/
      auth.ts                         # new — getAuthorizedClient()
      driveFiles.ts                   # new — DriveFilesClient type, listDriveFolders, listImagesInDriveFolder, downloadDriveFile
      indexGoogleDriveFolder.ts       # new — Drive orchestrator
    driveCli.ts                       # new — interactive folder picker + runIndexDrive
    cli.ts                            # modified — adds `index-drive` command
    config.ts                         # modified — adds GOOGLE_OAUTH_CLIENT_ID/SECRET
  test/
    processFile.test.ts               # new
    indexLocalFolder.test.ts          # modified — still exercises the same behavior through processFile
    google-auth.test.ts               # new
    google-driveFiles.test.ts         # new
    indexGoogleDriveFolder.test.ts    # new
    driveCli.test.ts                  # new
    cli.test.ts                       # modified — adds index-drive coverage
```

---

### Task 1: Extract shared `processFile` from `indexLocalFolder`

**Files:**
- Create: `agent/src/processFile.ts`
- Modify: `agent/src/indexLocalFolder.ts`
- Test: `agent/test/processFile.test.ts`
- Modify: `agent/test/indexLocalFolder.test.ts`

**Interfaces:**
- Consumes: `extractExifData` (Task 4 of the prior plan), `analyzeImage`, `generateText`, `generateThumbnail`, `CloudflareClient`/`IngestPhotoPayload`, `OllamaClient`, `AgentConfig` — all already in `agent/src/`.
- Produces: `ProcessFileInput` (`{ localPath: string; contentHash: string; source: 'local' | 'google_drive'; sourcePath?: string; driveFileId?: string; filename: string; album?: string }`) and `processFile(input: ProcessFileInput, deps: ProcessFileDeps): Promise<void>` in `agent/src/processFile.ts`. `ProcessFileDeps` is `{ cloudflareClient: CloudflareClient; ollamaClient: OllamaClient; config: AgentConfig }`. It runs EXIF extraction on `localPath`, analyzes `localPath` with Ollama, generates caption/hashtags, generates a thumbnail from `localPath`, uploads the thumbnail, then calls `ingestPhoto` — same order as today's `indexLocalFolder` loop body. Throws on any failure (caller decides how to count/log it — this function itself does not catch). Consumed by both `indexLocalFolder` (Task, this file) and `indexGoogleDriveFolder` (Task 6).

- [ ] **Step 1: Write the failing test — `agent/test/processFile.test.ts`**

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processFile } from '../src/processFile';
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

describe('processFile', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pixdex-process-'));
    filePath = path.join(dir, 'fixture.jpg');
    await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .jpeg()
      .toFile(filePath);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('uploads the thumbnail before ingesting metadata, for a local-source file', async () => {
    const calls: string[] = [];
    const cloudflareClient = {
      uploadThumbnail: vi.fn().mockImplementation(async () => {
        calls.push('uploadThumbnail');
      }),
      ingestPhoto: vi.fn().mockImplementation(async () => {
        calls.push('ingestPhoto');
      }),
    };
    const ollamaClient = { chat: vi.fn().mockResolvedValue(SAMPLE_RESPONSE) };

    await processFile(
      {
        localPath: filePath,
        contentHash: 'a'.repeat(64),
        source: 'local',
        sourcePath: filePath,
        filename: 'fixture.jpg',
      },
      { cloudflareClient: cloudflareClient as any, ollamaClient: ollamaClient as any, config }
    );

    expect(calls).toEqual(['uploadThumbnail', 'ingestPhoto']);
    const payload = cloudflareClient.ingestPhoto.mock.calls[0][0];
    expect(payload.source).toBe('local');
    expect(payload.path).toBe(filePath);
    expect(payload.driveFileId).toBeUndefined();
    expect(payload.modelProvider).toBe('ollama');
    expect(payload.subjects).toEqual(['leopard', 'big cat']);
  });

  it('sets driveFileId and omits path for a google_drive-source file', async () => {
    const cloudflareClient = {
      uploadThumbnail: vi.fn().mockResolvedValue(undefined),
      ingestPhoto: vi.fn().mockResolvedValue(undefined),
    };
    const ollamaClient = { chat: vi.fn().mockResolvedValue(SAMPLE_RESPONSE) };

    await processFile(
      {
        localPath: filePath,
        contentHash: 'b'.repeat(64),
        source: 'google_drive',
        driveFileId: 'drive-file-1',
        filename: 'fixture.jpg',
        album: 'Kanha Trip',
      },
      { cloudflareClient: cloudflareClient as any, ollamaClient: ollamaClient as any, config }
    );

    const payload = cloudflareClient.ingestPhoto.mock.calls[0][0];
    expect(payload.source).toBe('google_drive');
    expect(payload.driveFileId).toBe('drive-file-1');
    expect(payload.path).toBeUndefined();
    expect(payload.album).toBe('Kanha Trip');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `agent/`): `npm test`
Expected: FAIL — `src/processFile.ts` does not exist yet.

- [ ] **Step 3: Create `agent/src/processFile.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { extractExifData } from './exif';
import { generateThumbnail } from './thumbnail';
import { analyzeImage, type ImageAnalysisResult } from './ollama/analyzeImage';
import { generateText } from './ollama/generateText';
import type { OllamaClient } from './ollama/client';
import { CloudflareClient, type IngestPhotoPayload } from './cloudflareClient';
import type { AgentConfig } from './config';

export interface ProcessFileInput {
  localPath: string;
  contentHash: string;
  source: 'local' | 'google_drive';
  sourcePath?: string;
  driveFileId?: string;
  filename: string;
  album?: string;
}

export interface ProcessFileDeps {
  cloudflareClient: CloudflareClient;
  ollamaClient: OllamaClient;
  config: AgentConfig;
}

export async function processFile(input: ProcessFileInput, deps: ProcessFileDeps): Promise<void> {
  const { cloudflareClient, ollamaClient, config } = deps;

  const exif = await extractExifData(input.localPath);
  const analysis = await analyzeImage(input.localPath, ollamaClient);
  const caption = await generateText(buildCaptionPrompt(analysis), ollamaClient);
  const hashtags = await generateText(buildHashtagPrompt(analysis), ollamaClient);
  const thumbnail = await generateThumbnail(input.localPath);

  const payload: IngestPhotoPayload = {
    id: randomUUID(),
    contentHash: input.contentHash,
    source: input.source,
    path: input.sourcePath,
    driveFileId: input.driveFileId,
    filename: input.filename,
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
    album: input.album,
    description: analysis.description,
    suggestedCaption: caption,
    suggestedHashtags: parseHashtagList(hashtags),
    modelProvider: 'ollama',
    modelName: config.OLLAMA_MODEL,
  };

  // Upload the thumbnail before creating the D1 row: the thumbnail PUT is
  // safe to retry/duplicate (keyed by content hash), but once ingestPhoto
  // succeeds, future dedup checks skip this hash forever, so we must not
  // create the metadata row until we know the thumbnail landed.
  await cloudflareClient.uploadThumbnail(input.contentHash, thumbnail);
  await cloudflareClient.ingestPhoto(payload);
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

- [ ] **Step 4: Run the new test to verify it passes**

Run: `npm test -- processFile`
Expected: PASS

- [ ] **Step 5: Rewrite `agent/src/indexLocalFolder.ts` to use `processFile`**

```ts
import path from 'node:path';
import { isImageFile, scanDirectory } from './scanner';
import { sha256ContentHash } from './hashing';
import { processFile } from './processFile';
import type { OllamaClient } from './ollama/client';
import type { CloudflareClient } from './cloudflareClient';
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

  let indexed = 0;
  let skipped = 0;
  let failed = 0;

  const hashResults = await Promise.allSettled(imageFiles.map((file) => sha256ContentHash(file)));

  const hashedFiles: string[] = [];
  const hashedValues: string[] = [];
  for (let i = 0; i < imageFiles.length; i++) {
    const result = hashResults[i];
    if (result.status === 'fulfilled') {
      hashedFiles.push(imageFiles[i]);
      hashedValues.push(result.value);
    } else {
      failed++;
      const reason = result.reason;
      onProgress?.(
        `Failed: ${imageFiles[i]} (${reason instanceof Error ? reason.message : String(reason)})`
      );
    }
  }

  const knownHashes = await cloudflareClient.checkHashes(hashedValues);
  const processedHashes = new Set<string>();

  for (let i = 0; i < hashedFiles.length; i++) {
    const file = hashedFiles[i];
    const contentHash = hashedValues[i];

    if (knownHashes.has(contentHash)) {
      skipped++;
      onProgress?.(`Skipping already-indexed: ${file}`);
      continue;
    }
    if (processedHashes.has(contentHash)) {
      skipped++;
      onProgress?.(`Skipping duplicate content in this run: ${file}`);
      continue;
    }
    processedHashes.add(contentHash);

    try {
      await processFile(
        { localPath: file, contentHash, source: 'local', sourcePath: file, filename: path.basename(file) },
        { cloudflareClient, ollamaClient, config }
      );
      indexed++;
      onProgress?.(`Indexed: ${file}`);
    } catch (error) {
      failed++;
      onProgress?.(`Failed: ${file} (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  return { total: imageFiles.length, indexed, skipped, failed };
}
```

- [ ] **Step 6: Update `agent/test/indexLocalFolder.test.ts`'s mocks for the new shape**

The existing test mocks `cloudflareClient.ingestPhoto`/`uploadThumbnail` and `ollamaClient.chat` — those don't change. Only the assertion on *how* `ingestPhoto` is called needs no change either, since `processFile` builds the identical payload shape. Just re-run it:

Run: `npm test`
Expected: PASS — no edits needed if Phase 2's test already asserted on `ingestPhoto`/`uploadThumbnail` call args rather than internals. If it fails because it imported something now moved (e.g. `buildCaptionPrompt`), update those imports to point at `../src/processFile` instead of `../src/indexLocalFolder`.

- [ ] **Step 7: Commit**

```bash
git add agent/src/processFile.ts agent/src/indexLocalFolder.ts agent/test/processFile.test.ts agent/test/indexLocalFolder.test.ts
git commit -m "Extract shared processFile pipeline out of indexLocalFolder"
```

---

### Task 2: Google OAuth (loopback flow + token persistence)

**Files:**
- Create: `agent/.gitignore`
- Modify: `agent/src/config.ts`
- Create: `agent/src/google/auth.ts`
- Test: `agent/test/google-auth.test.ts`

**Interfaces:**
- Consumes: `AgentConfig` (extended here with `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET`).
- Produces: `getAuthorizedClient(config: AgentConfig, deps?: Partial<OAuthFlowDeps>): Promise<OAuth2Client>` in `agent/src/google/auth.ts`, consumed by `driveCli.ts` (Task 7) to construct the Drive client used by Tasks 3-6.

- [ ] **Step 1: Create `agent/.gitignore`**

```
node_modules/
.google-token.json
```

- [ ] **Step 2: Extend `agent/src/config.ts`**

```ts
import { z } from 'zod';

const configSchema = z.object({
  CLOUDFLARE_API_BASE_URL: z.string().url(),
  INGEST_TOKEN: z.string().min(1),
  OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().min(1).default('qwen3.5:27b-mlx'),
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
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

These are `optional()` (not required by every command) so `index-local` keeps working with no Google credentials configured at all; `index-drive` (Task 7) checks for their presence itself and fails fast with a clear message if they're missing.

- [ ] **Step 3: Write the failing test — `agent/test/google-auth.test.ts`**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const oauth2Instances: any[] = [];

vi.mock('googleapis', () => {
  class FakeOAuth2Client {
    credentials: Record<string, unknown> = {};
    generateAuthUrl = vi.fn().mockReturnValue('https://accounts.google.com/o/oauth2/auth?mock=1');
    getToken = vi.fn().mockResolvedValue({ tokens: { access_token: 'new-access', refresh_token: 'new-refresh' } });
    setCredentials = vi.fn((creds: Record<string, unknown>) => {
      this.credentials = creds;
    });
    constructor() {
      oauth2Instances.push(this);
    }
  }
  return { google: { auth: { OAuth2: FakeOAuth2Client } } };
});

const { getAuthorizedClient } = await import('../src/google/auth');

const config = {
  CLOUDFLARE_API_BASE_URL: 'https://example.workers.dev',
  INGEST_TOKEN: 'secret-token',
  OLLAMA_BASE_URL: 'http://localhost:11434',
  OLLAMA_MODEL: 'qwen3.5:27b-mlx',
  GOOGLE_OAUTH_CLIENT_ID: 'client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
} as const;

describe('getAuthorizedClient', () => {
  beforeEach(() => {
    oauth2Instances.length = 0;
  });

  it('reuses a stored token without running the browser flow', async () => {
    const readTokenFile = vi.fn().mockResolvedValue({ access_token: 'stored-access', refresh_token: 'stored-refresh' });
    const writeTokenFile = vi.fn();
    const openBrowser = vi.fn();
    const waitForAuthorizationCode = vi.fn();

    const client = await getAuthorizedClient(config as any, {
      readTokenFile,
      writeTokenFile,
      openBrowser,
      waitForAuthorizationCode,
    });

    expect(openBrowser).not.toHaveBeenCalled();
    expect(waitForAuthorizationCode).not.toHaveBeenCalled();
    expect(writeTokenFile).not.toHaveBeenCalled();
    expect((client as any).credentials).toEqual({ access_token: 'stored-access', refresh_token: 'stored-refresh' });
  });

  it('runs the browser flow and persists the resulting token when none is stored', async () => {
    const readTokenFile = vi.fn().mockResolvedValue(null);
    const writeTokenFile = vi.fn().mockResolvedValue(undefined);
    const openBrowser = vi.fn();
    const waitForAuthorizationCode = vi.fn().mockResolvedValue('authorization-code');

    const client = await getAuthorizedClient(config as any, {
      readTokenFile,
      writeTokenFile,
      openBrowser,
      waitForAuthorizationCode,
    });

    expect(openBrowser).toHaveBeenCalledWith(expect.stringContaining('accounts.google.com'));
    expect(waitForAuthorizationCode).toHaveBeenCalled();
    expect(writeTokenFile).toHaveBeenCalledWith({ access_token: 'new-access', refresh_token: 'new-refresh' });
    expect((client as any).credentials).toEqual({ access_token: 'new-access', refresh_token: 'new-refresh' });
  });

  it('throws a clear error when OAuth credentials are not configured', async () => {
    await expect(
      getAuthorizedClient({ ...config, GOOGLE_OAUTH_CLIENT_ID: undefined } as any)
    ).rejects.toThrow(/GOOGLE_OAUTH_CLIENT_ID/);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test -- google-auth`
Expected: FAIL — `src/google/auth.ts` does not exist yet.

- [ ] **Step 5: Create `agent/src/google/auth.ts`**

```ts
import { exec } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { google } from 'googleapis';
import type { AgentConfig } from '../config';

const TOKEN_PATH = path.resolve('.google-token.json');
const REDIRECT_PORT = 53682;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

export interface StoredToken {
  access_token?: string | null;
  refresh_token?: string | null;
  [key: string]: unknown;
}

export interface OAuthFlowDeps {
  openBrowser: (url: string) => void;
  waitForAuthorizationCode: (redirectUri: string) => Promise<string>;
  readTokenFile: () => Promise<StoredToken | null>;
  writeTokenFile: (token: StoredToken) => Promise<void>;
}

const defaultDeps: OAuthFlowDeps = {
  openBrowser(url) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${opener} "${url}"`);
  },
  waitForAuthorizationCode(redirectUri) {
    const port = Number(new URL(redirectUri).port);
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '', redirectUri);
        const code = url.searchParams.get('code');
        res.end(code ? 'Authorization complete — you can close this tab.' : 'Missing authorization code.');
        server.close();
        if (code) resolve(code);
        else reject(new Error('No authorization code received'));
      });
      server.listen(port);
    });
  },
  async readTokenFile() {
    try {
      const raw = await readFile(TOKEN_PATH, 'utf-8');
      return JSON.parse(raw) as StoredToken;
    } catch {
      return null;
    }
  },
  async writeTokenFile(token) {
    await writeFile(TOKEN_PATH, JSON.stringify(token, null, 2), 'utf-8');
  },
};

export async function getAuthorizedClient(
  config: AgentConfig,
  deps: Partial<OAuthFlowDeps> = {}
) {
  if (!config.GOOGLE_OAUTH_CLIENT_ID || !config.GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new Error(
      'GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set to use Google Drive indexing'
    );
  }

  const { openBrowser, waitForAuthorizationCode, readTokenFile, writeTokenFile } = {
    ...defaultDeps,
    ...deps,
  };

  const client = new google.auth.OAuth2(
    config.GOOGLE_OAUTH_CLIENT_ID,
    config.GOOGLE_OAUTH_CLIENT_SECRET,
    REDIRECT_URI
  );

  const stored = await readTokenFile();
  if (stored) {
    client.setCredentials(stored);
    return client;
  }

  const authUrl = client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
  openBrowser(authUrl);
  const code = await waitForAuthorizationCode(REDIRECT_URI);
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  await writeTokenFile(tokens);
  return client;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- google-auth`
Expected: PASS

- [ ] **Step 7: Add `googleapis` as a dependency**

Add to `agent/package.json` `dependencies`: `"googleapis": "^140.0.0"`. Run `npm install` (from `agent/`).

- [ ] **Step 8: Commit**

```bash
git add agent/.gitignore agent/src/config.ts agent/src/google/auth.ts agent/test/google-auth.test.ts agent/package.json agent/package-lock.json
git commit -m "Add Google OAuth loopback flow with local token persistence"
```

---

### Task 3 & 4: Drive folder listing and image listing

**Files:**
- Create: `agent/src/google/driveFiles.ts`
- Test: `agent/test/google-driveFiles.test.ts`

**Interfaces:**
- Produces: `DriveFilesClient` interface (a narrow subset of the `googleapis` Drive `files` resource — `list` and `get`, just enough to mock cleanly in tests and to satisfy structurally from the real SDK client). Produces `DriveFolderRef` (`{ id: string; name: string }`), `listDriveFolders(client: DriveFilesClient, query: string): Promise<DriveFolderRef[]>`. Produces `DriveImageRef` (`{ id: string; name: string; mimeType: string }`), `listImagesInDriveFolder(client: DriveFilesClient, folderId: string): Promise<DriveImageRef[]>` (paginates internally, returns the full list). Consumed by `driveCli.ts` (Task 7) and `indexGoogleDriveFolder` (Task 6).

- [ ] **Step 1: Write the failing test — `agent/test/google-driveFiles.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest';
import { listDriveFolders, listImagesInDriveFolder, type DriveFilesClient } from '../src/google/driveFiles';

describe('listDriveFolders', () => {
  it('searches by name and returns id/name pairs, escaping quotes in the query', async () => {
    const list = vi.fn().mockResolvedValue({ data: { files: [{ id: 'f1', name: 'Kanha 2026' }] } });
    const client: DriveFilesClient = { list, get: vi.fn() };

    const folders = await listDriveFolders(client, `O'Brien's Trip`);

    expect(folders).toEqual([{ id: 'f1', name: 'Kanha 2026' }]);
    const [params] = list.mock.calls[0];
    expect(params.q).toContain("mimeType='application/vnd.google-apps.folder'");
    expect(params.q).toContain("name contains 'O\\'Brien\\'s Trip'");
  });
});

describe('listImagesInDriveFolder', () => {
  it('paginates through all pages and filters to image mimeTypes', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          files: [{ id: 'i1', name: 'a.jpg', mimeType: 'image/jpeg' }],
          nextPageToken: 'page2',
        },
      })
      .mockResolvedValueOnce({
        data: { files: [{ id: 'i2', name: 'b.png', mimeType: 'image/png' }] },
      });
    const client: DriveFilesClient = { list, get: vi.fn() };

    const images = await listImagesInDriveFolder(client, 'folder-1');

    expect(images).toEqual([
      { id: 'i1', name: 'a.jpg', mimeType: 'image/jpeg' },
      { id: 'i2', name: 'b.png', mimeType: 'image/png' },
    ]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1][0].pageToken).toBe('page2');
    expect(list.mock.calls[0][0].q).toContain("'folder-1' in parents");
    expect(list.mock.calls[0][0].q).toContain("mimeType contains 'image/'");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- google-driveFiles`
Expected: FAIL — `src/google/driveFiles.ts` does not exist yet.

- [ ] **Step 3: Create `agent/src/google/driveFiles.ts`**

```ts
import type { Readable } from 'node:stream';

export interface DriveFilesClient {
  list(params: {
    q: string;
    fields: string;
    pageToken?: string;
    pageSize?: number;
  }): Promise<{
    data: {
      files: Array<{ id?: string | null; name?: string | null; mimeType?: string | null }>;
      nextPageToken?: string | null;
    };
  }>;
  get(
    params: { fileId: string; alt: 'media' },
    options: { responseType: 'stream' }
  ): Promise<{ data: Readable }>;
}

export interface DriveFolderRef {
  id: string;
  name: string;
}

export interface DriveImageRef {
  id: string;
  name: string;
  mimeType: string;
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export async function listDriveFolders(client: DriveFilesClient, query: string): Promise<DriveFolderRef[]> {
  const q = `mimeType='application/vnd.google-apps.folder' and trashed=false and name contains '${escapeDriveQueryValue(
    query
  )}'`;
  const response = await client.list({ q, fields: 'files(id,name)', pageSize: 50 });
  return (response.data.files ?? [])
    .filter((f): f is { id: string; name: string; mimeType?: string | null } => Boolean(f.id && f.name))
    .map((f) => ({ id: f.id, name: f.name }));
}

export async function listImagesInDriveFolder(
  client: DriveFilesClient,
  folderId: string
): Promise<DriveImageRef[]> {
  const images: DriveImageRef[] = [];
  let pageToken: string | undefined;

  do {
    const response = await client.list({
      q: `'${folderId}' in parents and mimeType contains 'image/' and trashed=false`,
      fields: 'nextPageToken, files(id,name,mimeType)',
      pageToken,
      pageSize: 100,
    });

    for (const file of response.data.files ?? []) {
      if (file.id && file.name && file.mimeType) {
        images.push({ id: file.id, name: file.name, mimeType: file.mimeType });
      }
    }

    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  return images;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- google-driveFiles`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/src/google/driveFiles.ts agent/test/google-driveFiles.test.ts
git commit -m "Add Drive folder and folder-scoped image listing"
```

---

### Task 5: Download a Drive file to a local temp path

**Files:**
- Modify: `agent/src/google/driveFiles.ts`
- Modify: `agent/test/google-driveFiles.test.ts`

**Interfaces:**
- Consumes: `DriveFilesClient` (Task 3/4, same file).
- Produces: `downloadDriveFile(client: DriveFilesClient, fileId: string, destPath: string): Promise<void>`, consumed by `indexGoogleDriveFolder` (Task 6).

- [ ] **Step 1: Add the failing test to `agent/test/google-driveFiles.test.ts`**

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach } from 'vitest';
import { downloadDriveFile } from '../src/google/driveFiles';

describe('downloadDriveFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pixdex-drive-download-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('streams the file body to destPath', async () => {
    const get = vi.fn().mockResolvedValue({ data: Readable.from([Buffer.from('fake jpeg bytes')]) });
    const client: DriveFilesClient = { list: vi.fn(), get };
    const destPath = path.join(dir, 'downloaded.jpg');

    await downloadDriveFile(client, 'file-1', destPath);

    expect(get).toHaveBeenCalledWith({ fileId: 'file-1', alt: 'media' }, { responseType: 'stream' });
    expect((await readFile(destPath)).toString()).toBe('fake jpeg bytes');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- google-driveFiles`
Expected: FAIL — `downloadDriveFile` is not exported yet.

- [ ] **Step 3: Append to `agent/src/google/driveFiles.ts`**

```ts
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

export async function downloadDriveFile(
  client: DriveFilesClient,
  fileId: string,
  destPath: string
): Promise<void> {
  const response = await client.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  await pipeline(response.data, createWriteStream(destPath));
}
```

(Move the two new imports to the top of the file alongside the existing `node:stream` import.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- google-driveFiles`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/src/google/driveFiles.ts agent/test/google-driveFiles.test.ts
git commit -m "Add Drive file download to a local temp path"
```

---

### Task 6: `indexGoogleDriveFolder` orchestrator

**Files:**
- Create: `agent/src/google/indexGoogleDriveFolder.ts`
- Test: `agent/test/indexGoogleDriveFolder.test.ts`

**Interfaces:**
- Consumes: `listImagesInDriveFolder`, `downloadDriveFile`, `DriveFilesClient` (Tasks 3-5), `sha256ContentHash` (prior plan), `processFile` (Task 1), `CloudflareClient`, `OllamaClient`, `AgentConfig`.
- Produces: `IndexGoogleDriveFolderResult` (`{ total, indexed, skipped, failed }`) and `indexGoogleDriveFolder(driveClient: DriveFilesClient, folderId: string, folderName: string, deps: IndexGoogleDriveFolderDeps): Promise<IndexGoogleDriveFolderResult>`, consumed by `driveCli.ts` (Task 7). For each image: download to a fresh temp path → hash → single-hash dedup check → `processFile` (or skip) → delete the temp file, always, even on failure.

- [ ] **Step 1: Write the failing test — `agent/test/indexGoogleDriveFolder.test.ts`**

```ts
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { indexGoogleDriveFolder } from '../src/google/indexGoogleDriveFolder';
import type { DriveFilesClient } from '../src/google/driveFiles';
import type { AgentConfig } from '../src/config';

const config: AgentConfig = {
  CLOUDFLARE_API_BASE_URL: 'https://example.workers.dev',
  INGEST_TOKEN: 'secret-token',
  OLLAMA_BASE_URL: 'http://localhost:11434',
  OLLAMA_MODEL: 'qwen3.5:27b-mlx',
};

const SAMPLE_RESPONSE = `SUBJECTS: leopard

COLORS: gold

PATTERNS: spots

SEASON: winter

ENVIRONMENT: forest

TAGS: leopard

DESCRIPTION: A leopard.`;

describe('indexGoogleDriveFolder', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'pixdex-drive-index-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('downloads, dedup-checks, processes, and cleans up each Drive image, skipping known hashes', async () => {
    const driveClient: DriveFilesClient = {
      list: vi.fn().mockResolvedValue({
        data: {
          files: [
            { id: 'known-1', name: 'known.jpg', mimeType: 'image/jpeg' },
            { id: 'new-1', name: 'new.jpg', mimeType: 'image/jpeg' },
          ],
        },
      }),
      get: vi.fn().mockResolvedValue({ data: Readable.from([Buffer.from('fake jpeg bytes')]) }),
    };

    const cloudflareClient = {
      checkHashes: vi.fn().mockImplementation(async (hashes: string[]) => {
        // Every file downloads to identical bytes in this test, so both
        // hashes are identical too — first call (known.jpg) reports it as
        // known; that hash then stays "known" for new.jpg as well, which
        // is fine: it correctly proves cross-file dedup within one run.
        return new Set(hashes);
      }),
      uploadThumbnail: vi.fn().mockResolvedValue(undefined),
      ingestPhoto: vi.fn().mockResolvedValue(undefined),
    };
    const ollamaClient = { chat: vi.fn().mockResolvedValue(SAMPLE_RESPONSE) };

    const result = await indexGoogleDriveFolder(driveClient, 'folder-1', 'Kanha 2026', {
      cloudflareClient: cloudflareClient as any,
      ollamaClient: ollamaClient as any,
      config,
      tempDir: tempRoot,
    });

    expect(result).toEqual({ total: 2, indexed: 0, skipped: 2, failed: 0 });
    expect(cloudflareClient.ingestPhoto).not.toHaveBeenCalled();

    const leftoverFiles = await readdir(tempRoot);
    expect(leftoverFiles).toHaveLength(0); // every downloaded temp file was cleaned up
  });

  it('cleans up the temp file even when processing fails', async () => {
    const driveClient: DriveFilesClient = {
      list: vi.fn().mockResolvedValue({
        data: { files: [{ id: 'broken-1', name: 'broken.jpg', mimeType: 'image/jpeg' }] },
      }),
      get: vi.fn().mockResolvedValue({ data: Readable.from([Buffer.from('fake jpeg bytes')]) }),
    };
    const cloudflareClient = {
      checkHashes: vi.fn().mockResolvedValue(new Set()),
      uploadThumbnail: vi.fn().mockRejectedValue(new Error('network error')),
      ingestPhoto: vi.fn(),
    };
    const ollamaClient = { chat: vi.fn().mockResolvedValue(SAMPLE_RESPONSE) };

    const result = await indexGoogleDriveFolder(driveClient, 'folder-1', 'Kanha 2026', {
      cloudflareClient: cloudflareClient as any,
      ollamaClient: ollamaClient as any,
      config,
      tempDir: tempRoot,
    });

    expect(result).toEqual({ total: 1, indexed: 0, skipped: 0, failed: 1 });
    expect(await readdir(tempRoot)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- indexGoogleDriveFolder`
Expected: FAIL — `src/google/indexGoogleDriveFolder.ts` does not exist yet.

- [ ] **Step 3: Create `agent/src/google/indexGoogleDriveFolder.ts`**

```ts
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { listImagesInDriveFolder, downloadDriveFile, type DriveFilesClient } from './driveFiles';
import { sha256ContentHash } from '../hashing';
import { processFile } from '../processFile';
import type { OllamaClient } from '../ollama/client';
import type { CloudflareClient } from '../cloudflareClient';
import type { AgentConfig } from '../config';

export interface IndexGoogleDriveFolderResult {
  total: number;
  indexed: number;
  skipped: number;
  failed: number;
}

export interface IndexGoogleDriveFolderDeps {
  cloudflareClient: CloudflareClient;
  ollamaClient: OllamaClient;
  config: AgentConfig;
  onProgress?: (message: string) => void;
  tempDir?: string;
}

export async function indexGoogleDriveFolder(
  driveClient: DriveFilesClient,
  folderId: string,
  folderName: string,
  deps: IndexGoogleDriveFolderDeps
): Promise<IndexGoogleDriveFolderResult> {
  const { cloudflareClient, ollamaClient, config, onProgress, tempDir = tmpdir() } = deps;

  const images = await listImagesInDriveFolder(driveClient, folderId);

  let indexed = 0;
  let skipped = 0;
  let failed = 0;

  for (const image of images) {
    const tempPath = path.join(tempDir, `pixdex-drive-${randomUUID()}-${image.name}`);

    try {
      await downloadDriveFile(driveClient, image.id, tempPath);
      const contentHash = await sha256ContentHash(tempPath);
      const knownHashes = await cloudflareClient.checkHashes([contentHash]);

      if (knownHashes.has(contentHash)) {
        skipped++;
        onProgress?.(`Skipping already-indexed: ${image.name}`);
        continue;
      }

      await processFile(
        {
          localPath: tempPath,
          contentHash,
          source: 'google_drive',
          driveFileId: image.id,
          filename: image.name,
          album: folderName,
        },
        { cloudflareClient, ollamaClient, config }
      );
      indexed++;
      onProgress?.(`Indexed: ${image.name}`);
    } catch (error) {
      failed++;
      onProgress?.(`Failed: ${image.name} (${error instanceof Error ? error.message : String(error)})`);
    } finally {
      await rm(tempPath, { force: true });
    }
  }

  return { total: images.length, indexed, skipped, failed };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- indexGoogleDriveFolder`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/src/google/indexGoogleDriveFolder.ts agent/test/indexGoogleDriveFolder.test.ts
git commit -m "Add Drive folder indexing orchestrator: download, hash, dedup, process, cleanup"
```

---

### Task 7: Interactive folder picker + `index-drive` CLI command

**Files:**
- Create: `agent/src/driveCli.ts`
- Modify: `agent/src/cli.ts`
- Test: `agent/test/driveCli.test.ts`
- Modify: `agent/test/cli.test.ts`

**Interfaces:**
- Consumes: `getAuthorizedClient` (Task 2), `listDriveFolders` (Task 3), `indexGoogleDriveFolder` (Task 6), `AgentConfig`.
- Produces: `runIndexDrive(config: AgentConfig, deps: RunIndexDriveDeps): Promise<number>` in `agent/src/driveCli.ts`, where `RunIndexDriveDeps` includes an injectable `prompt: (question: string) => Promise<string>` (so tests never touch real stdin) and `buildDriveClient: (auth: OAuth2Client) => DriveFilesClient`. Wired into `runCli` in `agent/src/cli.ts` as the `index-drive` command (no folder argument — it's interactive).

- [ ] **Step 1: Write the failing test — `agent/test/driveCli.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest';
import { runIndexDrive } from '../src/driveCli';
import type { AgentConfig } from '../src/config';

const config: AgentConfig = {
  CLOUDFLARE_API_BASE_URL: 'https://example.workers.dev',
  INGEST_TOKEN: 'secret-token',
  OLLAMA_BASE_URL: 'http://localhost:11434',
  OLLAMA_MODEL: 'qwen3.5:27b-mlx',
  GOOGLE_OAUTH_CLIENT_ID: 'client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
};

describe('runIndexDrive', () => {
  it('prompts for a search term, lists matching folders, prompts for a choice, and indexes it', async () => {
    const prompts = ['Kanha', '1'];
    const prompt = vi.fn().mockImplementation(async () => prompts.shift());

    const listDriveFolders = vi.fn().mockResolvedValue([{ id: 'folder-1', name: 'Kanha 2026' }]);
    const indexGoogleDriveFolder = vi
      .fn()
      .mockResolvedValue({ total: 2, indexed: 1, skipped: 1, failed: 0 });
    const getAuthorizedClient = vi.fn().mockResolvedValue({ mock: 'auth-client' });
    const buildDriveClient = vi.fn().mockReturnValue({ mock: 'drive-client' });

    const code = await runIndexDrive(config, {
      prompt,
      getAuthorizedClient,
      buildDriveClient,
      listDriveFolders,
      indexGoogleDriveFolder,
    });

    expect(code).toBe(0);
    expect(listDriveFolders).toHaveBeenCalledWith({ mock: 'drive-client' }, 'Kanha');
    expect(indexGoogleDriveFolder).toHaveBeenCalledWith(
      { mock: 'drive-client' },
      'folder-1',
      'Kanha 2026',
      expect.any(Object)
    );
  });

  it('returns 1 and does not index when no folders match the search', async () => {
    const prompt = vi.fn().mockResolvedValue('Nonexistent');
    const listDriveFolders = vi.fn().mockResolvedValue([]);
    const indexGoogleDriveFolder = vi.fn();

    const code = await runIndexDrive(config, {
      prompt,
      getAuthorizedClient: vi.fn().mockResolvedValue({}),
      buildDriveClient: vi.fn().mockReturnValue({}),
      listDriveFolders,
      indexGoogleDriveFolder,
    });

    expect(code).toBe(1);
    expect(indexGoogleDriveFolder).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- driveCli`
Expected: FAIL — `src/driveCli.ts` does not exist yet.

- [ ] **Step 3: Create `agent/src/driveCli.ts`**

```ts
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { getAuthorizedClient as defaultGetAuthorizedClient } from './google/auth';
import { listDriveFolders as defaultListDriveFolders, type DriveFilesClient } from './google/driveFiles';
import { indexGoogleDriveFolder as defaultIndexGoogleDriveFolder } from './google/indexGoogleDriveFolder';
import { CloudflareClient } from './cloudflareClient';
import { OllamaClient } from './ollama/client';
import type { AgentConfig } from './config';

export interface RunIndexDriveDeps {
  prompt: (question: string) => Promise<string>;
  getAuthorizedClient?: typeof defaultGetAuthorizedClient;
  buildDriveClient?: (auth: OAuth2Client) => DriveFilesClient;
  listDriveFolders?: typeof defaultListDriveFolders;
  indexGoogleDriveFolder?: typeof defaultIndexGoogleDriveFolder;
}

export async function runIndexDrive(config: AgentConfig, deps: RunIndexDriveDeps): Promise<number> {
  const {
    prompt,
    getAuthorizedClient = defaultGetAuthorizedClient,
    buildDriveClient = (auth) => google.drive({ version: 'v3', auth }).files as unknown as DriveFilesClient,
    listDriveFolders = defaultListDriveFolders,
    indexGoogleDriveFolder = defaultIndexGoogleDriveFolder,
  } = deps;

  const auth = await getAuthorizedClient(config);
  const driveClient = buildDriveClient(auth as OAuth2Client);

  const searchTerm = (await prompt('Search Google Drive folders by name: ')).trim();
  const folders = await listDriveFolders(driveClient, searchTerm);

  if (folders.length === 0) {
    console.error(`No folders found matching "${searchTerm}"`);
    return 1;
  }

  console.log('Matching folders:');
  folders.forEach((folder, i) => console.log(`  ${i + 1}. ${folder.name}`));

  const choice = Number((await prompt(`Pick a folder (1-${folders.length}): `)).trim());
  const selected = folders[choice - 1];
  if (!selected) {
    console.error('Invalid selection');
    return 1;
  }

  const result = await indexGoogleDriveFolder(driveClient, selected.id, selected.name, {
    cloudflareClient: new CloudflareClient(config),
    ollamaClient: new OllamaClient(config),
    config,
    onProgress: (message) => console.log(message),
  });

  console.log(
    `Done. Total: ${result.total}, Indexed: ${result.indexed}, Skipped: ${result.skipped}, Failed: ${result.failed}`
  );
  return 0;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- driveCli`
Expected: PASS

- [ ] **Step 5: Wire `index-drive` into `agent/src/cli.ts`**

```ts
import { createInterface } from 'node:readline/promises';
import { loadConfig } from './config';
import { CloudflareClient } from './cloudflareClient';
import { OllamaClient } from './ollama/client';
import { indexLocalFolder } from './indexLocalFolder';
import { runIndexDrive } from './driveCli';

export async function runCli(argv: string[]): Promise<number> {
  const [command, folder] = argv;

  if (command === 'index-drive') {
    const config = loadConfig();
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await runIndexDrive(config, { prompt: (question) => rl.question(question) });
    } finally {
      rl.close();
    }
  }

  if (command !== 'index-local' || !folder) {
    console.error('Usage: pixdex-agent index-local <folder>\n       pixdex-agent index-drive');
    return 1;
  }

  const config = loadConfig();
  const cloudflareClient = new CloudflareClient(config);
  const ollamaClient = new OllamaClient(config);

  try {
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
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
```

- [ ] **Step 6: Add coverage to `agent/test/cli.test.ts`**

```ts
// alongside the existing vi.mock calls at the top of the file:
const runIndexDriveMock = vi.fn();
vi.mock('../src/driveCli', () => ({ runIndexDrive: runIndexDriveMock }));

// alongside the existing `describe('runCli', ...)` block's tests:
it('delegates "index-drive" to runIndexDrive', async () => {
  runIndexDriveMock.mockReset().mockResolvedValue(0);
  const code = await runCli(['index-drive']);
  expect(code).toBe(0);
  expect(runIndexDriveMock).toHaveBeenCalledWith(expect.any(Object), expect.any(Object));
});
```

- [ ] **Step 7: Run the full agent test suite**

Run: `npm test`
Expected: PASS (all suites, including the extended `cli.test.ts`)

- [ ] **Step 8: Commit**

```bash
git add agent/src/driveCli.ts agent/src/cli.ts agent/test/driveCli.test.ts agent/test/cli.test.ts
git commit -m "Add interactive Google Drive folder picker and index-drive CLI command"
```

---

## After this plan

The local agent can now index either local folders (`pixdex-agent index-local <folder>`) or a Google Drive folder picked interactively (`pixdex-agent index-drive`), with identical downstream processing and identical cross-source dedup by content hash. Remaining plans, per the spec:

1. **Pages frontend** — calls the Worker's `/search`, `/photos/:id`, `/albums`, `/daily-pick`, `/thumbnails/:contentHash`. This is also where `src/server`, `src/services/llm`, `src/services/indexer`, `src/services/vectorstore`, and the Chroma docker-compose service finally get deleted, once nothing in the repo still depends on them.
2. **Cloudflare Tunnel for originals** — a small addition to `agent/` serving already-indexed local-disk originals over `cloudflared`, scoped to indexed paths only.
