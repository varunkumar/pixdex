# Cloudflare Tunnel for Originals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the web UI open a full-resolution original for a local-disk photo, from anywhere, on demand — without ever uploading originals to Cloudflare. This is the last plan in the redesign; after it, every goal in the spec is implemented.

**Architecture:** The local agent gains a small, long-running HTTP server (`serve-originals`) that, on each request, asks the already-deployed Worker "is this photo id indexed, and is it local-disk?" via the public `GET /photos/:id` route, and only then streams the file at the path the Worker itself reports — it never accepts an arbitrary filesystem path from the request. A Cloudflare Tunnel (`cloudflared`, account/domain setup is a one-time manual step — not something a test can exercise) exposes that local server at a stable public URL. The frontend adds a "View Original" link per photo: for Drive-sourced photos it deep-links straight to Drive (no tunnel involved); for local-disk photos it points at the tunnel URL, and if the Mac/agent/tunnel happens to be off, the link simply fails to load in the browser's own way — no special "is it up" health check is built, matching the spec's accepted degradation.

**Tech Stack:** Node's built-in `node:http` (the originals server — no new HTTP framework dependency), `mime-types` (already an `agent/` dependency), `cloudflared` (external binary, user-installed, not an npm dependency), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-18-pixdex-local-cloud-redesign-design.md`

**Depends on:** the Worker (`docs/superpowers/plans/2026-09-18-pixdex-cloudflare-backend.md`) for `GET /photos/:id` → `SerializedPhoto` (`worker/src/db/photos.ts`), and the frontend (`docs/superpowers/plans/2026-09-21-pixdex-pages-frontend.md`) for `SerializedPhoto` (`src/types/api.ts`) and `WorkerApiClient` (`src/services/api/WorkerApiClient.ts`), both merged to `main`. Both `SerializedPhoto` shapes already carry `source: 'local' | 'google_drive'`, `path: string | null`, and `driveFileId: string | null` — no backend or type change is needed, only new agent/frontend code that reads them.

## Global Constraints

- The originals server must never serve a path it wasn't told about by the Worker's own `/photos/:id` response — no path comes from request input. (spec §7, "scoped strictly to paths that are already indexed")
- Drive-sourced photos never go through the tunnel — they deep-link to Drive directly. (spec §6)
- A missing/offline agent or tunnel degrades to "the link doesn't load" — this plan does not build a liveness/health indicator in the UI.
- The shared token embedded in the frontend build (`VITE_ORIGINALS_TOKEN`) is visible to anyone who loads the page — it protects against URL-guessing by outsiders, not against someone who already has access to the deployed site. This is an accepted, stated tradeoff for a single-user personal app, not a security bug to fix later.

---

## File Structure

```
agent/
  src/
    originals/
      lookupPhoto.ts             # new — fetchIndexedPhoto()
      server.ts                  # new — createOriginalsServer()
    originalsCli.ts               # new — runServeOriginals()
    cli.ts                        # modified — adds `serve-originals` command
    config.ts                     # modified — adds ORIGINALS_PORT/ORIGINALS_TOKEN
  cloudflared/
    config.yml                    # new — ingress config (tunnel ID filled in by the user, see Task 5)
    README.md                     # new — exact one-time setup commands
  .env.example                    # modified
  test/
    originals-lookupPhoto.test.ts # new
    originals-server.test.ts      # new
    originalsCli.test.ts          # new
    cli.test.ts                   # modified

src/
  services/
    originals.ts                  # new — getOriginalUrl()
  components/
    Search.tsx                   # modified — adds "View Original" link
    DailySuggestion.tsx          # modified — adds "View Original" link
  vite-env.d.ts                   # modified — adds VITE_ORIGINALS_BASE_URL/TOKEN
  test/
    services/originals.test.ts    # new
  components/__tests__/
    Search.test.tsx               # modified
    DailySuggestion.test.tsx      # modified
.env.example                      # modified (root, frontend)
README.md                         # modified — documents the tunnel setup end-to-end
```

---

### Task 1: Look up an indexed photo's local path

**Files:**
- Create: `agent/src/originals/lookupPhoto.ts`
- Test: `agent/test/originals-lookupPhoto.test.ts`

**Interfaces:**
- Produces: `IndexedPhotoLookup` (`{ source: string; path: string | null }`) and `fetchIndexedPhoto(baseUrl: string, id: string, fetchFn?: typeof fetch): Promise<IndexedPhotoLookup | null>` — `null` on a 404 (unknown photo id), throws on any other non-2xx. Consumed by `createOriginalsServer` (Task 3).

- [ ] **Step 1: Write the failing test — `agent/test/originals-lookupPhoto.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest';
import { fetchIndexedPhoto } from '../src/originals/lookupPhoto';

describe('fetchIndexedPhoto', () => {
  it('returns the source/path for a known photo', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ source: 'local', path: '/photos/a.jpg' }), { status: 200 }));

    const result = await fetchIndexedPhoto('https://example.workers.dev', 'photo-1', fetchMock);

    expect(result).toEqual({ source: 'local', path: '/photos/a.jpg' });
    expect(fetchMock).toHaveBeenCalledWith('https://example.workers.dev/photos/photo-1');
  });

  it('returns null for an unknown photo id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    expect(await fetchIndexedPhoto('https://example.workers.dev', 'missing', fetchMock)).toBeNull();
  });

  it('throws on any other error status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    await expect(fetchIndexedPhoto('https://example.workers.dev', 'photo-1', fetchMock)).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `agent/`): `npm test -- originals-lookupPhoto`
Expected: FAIL — `src/originals/lookupPhoto.ts` does not exist yet.

- [ ] **Step 3: Create `agent/src/originals/lookupPhoto.ts`**

```ts
export interface IndexedPhotoLookup {
  source: string;
  path: string | null;
}

export async function fetchIndexedPhoto(
  baseUrl: string,
  id: string,
  fetchFn: typeof fetch = fetch
): Promise<IndexedPhotoLookup | null> {
  const response = await fetchFn(`${baseUrl}/photos/${id}`);

  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to look up photo ${id}: ${response.status}`);
  }

  const body = (await response.json()) as { source?: string; path?: string | null };
  return { source: body.source ?? '', path: body.path ?? null };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- originals-lookupPhoto`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/src/originals/lookupPhoto.ts agent/test/originals-lookupPhoto.test.ts
git commit -m "Add Worker photo lookup for the originals server"
```

---

### Task 2: Config additions for the originals server

**Files:**
- Modify: `agent/src/config.ts`
- Modify: `agent/.env.example`
- Test: extend `agent/test/config.test.ts`

**Interfaces:**
- Produces: `AgentConfig.ORIGINALS_PORT` (`number`, default `8787`) and `AgentConfig.ORIGINALS_TOKEN` (`string | undefined` — optional, since `index-local`/`index-drive` don't need it), consumed by `createOriginalsServer` (Task 3) and `runServeOriginals` (Task 4).

- [ ] **Step 1: Add the failing cases to `agent/test/config.test.ts`**

```ts
it('defaults ORIGINALS_PORT to 8787 and leaves ORIGINALS_TOKEN unset', () => {
  const config = loadConfig({
    CLOUDFLARE_API_BASE_URL: 'https://example.workers.dev',
    INGEST_TOKEN: 'secret-token',
  });
  expect(config.ORIGINALS_PORT).toBe(8787);
  expect(config.ORIGINALS_TOKEN).toBeUndefined();
});

it('respects explicit ORIGINALS_PORT and ORIGINALS_TOKEN overrides', () => {
  const config = loadConfig({
    CLOUDFLARE_API_BASE_URL: 'https://example.workers.dev',
    INGEST_TOKEN: 'secret-token',
    ORIGINALS_PORT: '9000',
    ORIGINALS_TOKEN: 'originals-secret',
  });
  expect(config.ORIGINALS_PORT).toBe(9000);
  expect(config.ORIGINALS_TOKEN).toBe('originals-secret');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- config`
Expected: FAIL — `ORIGINALS_PORT` is `undefined`, not `8787`.

- [ ] **Step 3: Extend `agent/src/config.ts`**

```ts
import { z } from 'zod';

const configSchema = z.object({
  CLOUDFLARE_API_BASE_URL: z.string().url(),
  INGEST_TOKEN: z.string().min(1),
  OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().min(1).default('qwen3.5:27b-mlx'),
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  ORIGINALS_PORT: z.coerce.number().int().positive().default(8787),
  ORIGINALS_TOKEN: z.string().min(1).optional(),
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

- [ ] **Step 4: Append to `agent/.env.example`**

```

# Optional: required only for `pixdex-agent serve-originals` (the
# Cloudflare Tunnel that exposes full-resolution local-disk originals).
# ORIGINALS_PORT is the local port the server listens on; cloudflared's
# ingress config (agent/cloudflared/config.yml) must point at the same one.
ORIGINALS_PORT=8787
ORIGINALS_TOKEN=replace-with-a-random-shared-secret
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- config`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add agent/src/config.ts agent/.env.example agent/test/config.test.ts
git commit -m "Add ORIGINALS_PORT/ORIGINALS_TOKEN config for the originals server"
```

---

### Task 3: The originals HTTP server

**Files:**
- Create: `agent/src/originals/server.ts`
- Test: `agent/test/originals-server.test.ts`

**Interfaces:**
- Consumes: `fetchIndexedPhoto` (Task 1), `AgentConfig` (Task 2).
- Produces: `createOriginalsServer(config: AgentConfig, deps?: Partial<OriginalsServerDeps>): http.Server`, where `OriginalsServerDeps = { fetchIndexedPhoto: typeof fetchIndexedPhoto }` (injectable for testing). Serves `GET /originals/:id?token=<ORIGINALS_TOKEN>`. Consumed by `runServeOriginals` (Task 4).

- [ ] **Step 1: Write the failing test — `agent/test/originals-server.test.ts`**

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOriginalsServer } from '../src/originals/server';
import type { AgentConfig } from '../src/config';

const config: AgentConfig = {
  CLOUDFLARE_API_BASE_URL: 'https://example.workers.dev',
  INGEST_TOKEN: 'secret-token',
  OLLAMA_BASE_URL: 'http://localhost:11434',
  OLLAMA_MODEL: 'qwen3.5:27b-mlx',
  ORIGINALS_PORT: 8787,
  ORIGINALS_TOKEN: 'originals-secret',
};

describe('originals server', () => {
  let dir: string;
  let filePath: string;
  let baseUrl: string;
  let server: ReturnType<typeof createOriginalsServer>;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'pixdex-originals-'));
    filePath = path.join(dir, 'photo.jpg');
    await writeFile(filePath, 'fake jpeg bytes');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  });

  async function start(deps: Parameters<typeof createOriginalsServer>[1] = {}) {
    server = createOriginalsServer(config, deps);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  }

  it('streams the file for a known local photo with a valid token', async () => {
    await start({ fetchIndexedPhoto: vi.fn().mockResolvedValue({ source: 'local', path: filePath }) });

    const response = await fetch(`${baseUrl}/originals/photo-1?token=originals-secret`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('fake jpeg bytes');
  });

  it('rejects a missing or wrong token', async () => {
    await start({ fetchIndexedPhoto: vi.fn() });
    const response = await fetch(`${baseUrl}/originals/photo-1?token=wrong`);
    expect(response.status).toBe(401);
  });

  it('returns 404 for a Drive-sourced photo, since there is no local path to serve', async () => {
    await start({ fetchIndexedPhoto: vi.fn().mockResolvedValue({ source: 'google_drive', path: null }) });
    const response = await fetch(`${baseUrl}/originals/photo-1?token=originals-secret`);
    expect(response.status).toBe(404);
  });

  it('returns 404 when the file no longer exists on disk', async () => {
    await start({
      fetchIndexedPhoto: vi.fn().mockResolvedValue({ source: 'local', path: path.join(dir, 'missing.jpg') }),
    });
    const response = await fetch(`${baseUrl}/originals/photo-1?token=originals-secret`);
    expect(response.status).toBe(404);
  });

  it('returns 404 for an unrecognized path shape', async () => {
    await start({ fetchIndexedPhoto: vi.fn() });
    const response = await fetch(`${baseUrl}/not-originals/photo-1`);
    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- originals-server`
Expected: FAIL — `src/originals/server.ts` does not exist yet.

- [ ] **Step 3: Create `agent/src/originals/server.ts`**

```ts
import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import mime from 'mime-types';
import { fetchIndexedPhoto } from './lookupPhoto';
import type { AgentConfig } from '../config';

export interface OriginalsServerDeps {
  fetchIndexedPhoto: typeof fetchIndexedPhoto;
}

const defaultDeps: OriginalsServerDeps = { fetchIndexedPhoto };

const PATH_PATTERN = /^\/originals\/([^/]+)$/;

export function createOriginalsServer(
  config: AgentConfig,
  deps: Partial<OriginalsServerDeps> = {}
): Server {
  const { fetchIndexedPhoto: lookup } = { ...defaultDeps, ...deps };

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = url.pathname.match(PATH_PATTERN);

    if (!match) {
      res.writeHead(404).end('Not Found');
      return;
    }

    if (!config.ORIGINALS_TOKEN || url.searchParams.get('token') !== config.ORIGINALS_TOKEN) {
      res.writeHead(401).end('Unauthorized');
      return;
    }

    const photoId = match[1];

    try {
      const photo = await lookup(config.CLOUDFLARE_API_BASE_URL, photoId);
      if (!photo || photo.source !== 'local' || !photo.path) {
        res.writeHead(404).end('Not Found');
        return;
      }

      await access(photo.path);
      const stats = await stat(photo.path);
      const contentType = mime.lookup(photo.path) || 'application/octet-stream';

      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stats.size });
      createReadStream(photo.path).pipe(res);
    } catch {
      res.writeHead(404).end('Not Found');
    }
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- originals-server`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/src/originals/server.ts agent/test/originals-server.test.ts
git commit -m "Add originals HTTP server: token-gated, Worker-verified local file streaming"
```

---

### Task 4: `serve-originals` CLI command

**Files:**
- Create: `agent/src/originalsCli.ts`
- Modify: `agent/src/cli.ts`
- Test: `agent/test/originalsCli.test.ts`
- Modify: `agent/test/cli.test.ts`

**Interfaces:**
- Consumes: `createOriginalsServer` (Task 3), `AgentConfig` (Task 2).
- Produces: `runServeOriginals(config: AgentConfig, deps?: { createServer?: typeof createOriginalsServer }): number`, wired into `runCli` (`agent/src/cli.ts`) as the `serve-originals` command (no arguments, long-running — the process stays alive because the HTTP server keeps listening).

- [ ] **Step 1: Write the failing test — `agent/test/originalsCli.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest';
import { runServeOriginals } from '../src/originalsCli';
import type { AgentConfig } from '../src/config';

const baseConfig: AgentConfig = {
  CLOUDFLARE_API_BASE_URL: 'https://example.workers.dev',
  INGEST_TOKEN: 'secret-token',
  OLLAMA_BASE_URL: 'http://localhost:11434',
  OLLAMA_MODEL: 'qwen3.5:27b-mlx',
  ORIGINALS_PORT: 8787,
  ORIGINALS_TOKEN: 'originals-secret',
};

describe('runServeOriginals', () => {
  it('starts the server on ORIGINALS_PORT and returns 0', () => {
    const listen = vi.fn((_port: number, cb: () => void) => cb());
    const createServer = vi.fn().mockReturnValue({ listen });

    const code = runServeOriginals(baseConfig, { createServer });

    expect(code).toBe(0);
    expect(createServer).toHaveBeenCalledWith(baseConfig);
    expect(listen).toHaveBeenCalledWith(8787, expect.any(Function));
  });

  it('returns 1 without starting a server when ORIGINALS_TOKEN is unset', () => {
    const createServer = vi.fn();
    const code = runServeOriginals({ ...baseConfig, ORIGINALS_TOKEN: undefined }, { createServer });

    expect(code).toBe(1);
    expect(createServer).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- originalsCli`
Expected: FAIL — `src/originalsCli.ts` does not exist yet.

- [ ] **Step 3: Create `agent/src/originalsCli.ts`**

```ts
import { createOriginalsServer } from './originals/server';
import type { AgentConfig } from './config';

export interface RunServeOriginalsDeps {
  createServer?: typeof createOriginalsServer;
}

export function runServeOriginals(config: AgentConfig, deps: RunServeOriginalsDeps = {}): number {
  if (!config.ORIGINALS_TOKEN) {
    console.error('ORIGINALS_TOKEN must be set to run serve-originals');
    return 1;
  }

  const { createServer = createOriginalsServer } = deps;
  const server = createServer(config);

  server.listen(config.ORIGINALS_PORT, () => {
    console.log(`Serving indexed local-disk originals on http://localhost:${config.ORIGINALS_PORT}`);
    console.log('Run "cloudflared tunnel --config agent/cloudflared/config.yml run pixdex-originals" separately to expose it.');
  });

  return 0;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- originalsCli`
Expected: PASS

- [ ] **Step 5: Wire `serve-originals` into `agent/src/cli.ts`**

```ts
import { createInterface } from 'node:readline/promises';
import { loadConfig } from './config';
import { CloudflareClient } from './cloudflareClient';
import { OllamaClient } from './ollama/client';
import { indexLocalFolder } from './indexLocalFolder';
import { runIndexDrive } from './driveCli';
import { runServeOriginals } from './originalsCli';

export async function runCli(argv: string[]): Promise<number> {
  const [command, folder] = argv;

  if (command === 'serve-originals') {
    return runServeOriginals(loadConfig());
  }

  if (command === 'index-drive') {
    const config = loadConfig();
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await runIndexDrive(config, { prompt: (question) => rl.question(question) });
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    } finally {
      rl.close();
    }
  }

  if (command !== 'index-local' || !folder) {
    console.error(
      'Usage: pixdex-agent index-local <folder>\n       pixdex-agent index-drive\n       pixdex-agent serve-originals'
    );
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
const runServeOriginalsMock = vi.fn();
vi.mock('../src/originalsCli', () => ({ runServeOriginals: runServeOriginalsMock }));

// alongside the existing tests:
it('delegates "serve-originals" to runServeOriginals', async () => {
  runServeOriginalsMock.mockReset().mockReturnValue(0);
  const code = await runCli(['serve-originals']);
  expect(code).toBe(0);
  expect(runServeOriginalsMock).toHaveBeenCalledWith(expect.any(Object));
});
```

- [ ] **Step 7: Run the full agent test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add agent/src/originalsCli.ts agent/src/cli.ts agent/test/originalsCli.test.ts agent/test/cli.test.ts
git commit -m "Add serve-originals CLI command"
```

---

### Task 5: Cloudflare Tunnel setup (config + manual one-time steps)

**Files:**
- Create: `agent/cloudflared/config.yml`
- Create: `agent/cloudflared/README.md`

**Interfaces:** none — this task has no automated test. `cloudflared tunnel create` and `tunnel route dns` require a real Cloudflare account and domain and cannot be exercised in CI; the config file's `tunnel:`/`credentials-file:` values are filled in by the person running these commands, not invented here.

- [ ] **Step 1: Create `agent/cloudflared/config.yml`**

```yaml
# Fill in <TUNNEL_ID> after running `cloudflared tunnel create pixdex-originals`
# (see README.md in this directory for the full one-time setup).
tunnel: <TUNNEL_ID>
credentials-file: ~/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: pixdex-originals.<your-domain>
    service: http://localhost:8787
  - service: http_status:404
```

- [ ] **Step 2: Create `agent/cloudflared/README.md`**

```markdown
# Cloudflare Tunnel for originals

One-time setup (requires a Cloudflare account with a domain on it):

1. Install `cloudflared` (e.g. `brew install cloudflared` on macOS).
2. Log in and create the tunnel:

   ```bash
   cloudflared tunnel login
   cloudflared tunnel create pixdex-originals
   ```

   This prints a Tunnel ID and writes credentials to
   `~/.cloudflared/<TUNNEL_ID>.json`.

3. Edit `agent/cloudflared/config.yml`: replace both `<TUNNEL_ID>` placeholders
   with the ID from step 2, and `<your-domain>` with a domain in your
   Cloudflare account.
4. Route DNS for that hostname to the tunnel:

   ```bash
   cloudflared tunnel route dns pixdex-originals pixdex-originals.<your-domain>
   ```

5. Set `ORIGINALS_TOKEN` in `agent/.env` to a random secret, and set
   `VITE_ORIGINALS_BASE_URL=https://pixdex-originals.<your-domain>` and
   `VITE_ORIGINALS_TOKEN=<the same secret>` in the frontend's `.env`
   (see the root `.env.example`).

## Running it

Two processes need to be running at the same time on the machine that has
your local photos:

```bash
# terminal 1, from agent/
npm run dev -- serve-originals

# terminal 2, from anywhere
cloudflared tunnel --config agent/cloudflared/config.yml run pixdex-originals
```

If either one isn't running, "View Original" links for local-disk photos in
the web UI simply fail to load — this is expected, not a bug to chase; see
the spec's Global Constraints on this.
```

- [ ] **Step 3: Commit**

```bash
git add agent/cloudflared/config.yml agent/cloudflared/README.md
git commit -m "Add Cloudflare Tunnel config and setup instructions for originals"
```

---

### Task 6: `getOriginalUrl` helper

**Files:**
- Create: `src/services/originals.ts`
- Modify: `src/vite-env.d.ts`
- Modify: root `.env.example`
- Test: `src/services/__tests__/originals.test.ts`

**Interfaces:**
- Consumes: `SerializedPhoto` (`src/types/api.ts`).
- Produces: `OriginalsConfig` (`{ baseUrl: string; token: string }`), `getOriginalUrl(photo: SerializedPhoto, config: OriginalsConfig): string | null`, and a ready-to-use `originalsConfig` singleton built from `import.meta.env.VITE_ORIGINALS_BASE_URL`/`VITE_ORIGINALS_TOKEN`. Consumed by `Search.tsx` and `DailySuggestion.tsx` (Task 7).

- [ ] **Step 1: Extend `src/vite-env.d.ts`**

```ts
/// <reference types="vite/client" />
/// <reference types="@testing-library/jest-dom/vitest" />

interface ImportMetaEnv {
  readonly VITE_WORKER_API_BASE_URL: string;
  readonly VITE_ORIGINALS_BASE_URL?: string;
  readonly VITE_ORIGINALS_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

- [ ] **Step 2: Append to the root `.env.example`**

```

# Optional: only needed for "View Original" on local-disk photos, once
# agent/cloudflared is set up (see agent/cloudflared/README.md).
VITE_ORIGINALS_BASE_URL=https://pixdex-originals.<your-domain>
VITE_ORIGINALS_TOKEN=replace-with-the-same-value-as-agent/.env's-ORIGINALS_TOKEN
```

- [ ] **Step 3: Write the failing test — `src/services/__tests__/originals.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { getOriginalUrl } from '../originals';
import type { SerializedPhoto } from '../../types/api';

const basePhoto: SerializedPhoto = {
  id: 'p1',
  path: null,
  driveFileId: null,
  dateTime: null,
  width: null,
  height: null,
  format: null,
  fileSize: null,
  subjects: [],
  colors: [],
  patterns: [],
  tags: [],
  season: null,
  environment: null,
  album: null,
  suggestedHashtags: [],
  instagramSuggested: null,
};

describe('getOriginalUrl', () => {
  it('returns a Drive view link for google_drive photos, regardless of tunnel config', () => {
    const photo: SerializedPhoto = { ...basePhoto, source: 'google_drive', driveFileId: 'abc123' };
    expect(getOriginalUrl(photo, { baseUrl: '', token: '' })).toBe('https://drive.google.com/file/d/abc123/view');
  });

  it('returns a token-bearing tunnel URL for local photos when the tunnel is configured', () => {
    const photo: SerializedPhoto = { ...basePhoto, source: 'local' };
    expect(getOriginalUrl(photo, { baseUrl: 'https://pixdex-originals.example.com', token: 'shh' })).toBe(
      'https://pixdex-originals.example.com/originals/p1?token=shh'
    );
  });

  it('returns null for local photos when the tunnel is not configured', () => {
    const photo: SerializedPhoto = { ...basePhoto, source: 'local' };
    expect(getOriginalUrl(photo, { baseUrl: '', token: '' })).toBeNull();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test -- originals.test`
Expected: FAIL — `src/services/originals.ts` does not exist yet.

- [ ] **Step 5: Create `src/services/originals.ts`**

```ts
import type { SerializedPhoto } from '../types/api';

export interface OriginalsConfig {
  baseUrl: string;
  token: string;
}

export function getOriginalUrl(photo: SerializedPhoto, config: OriginalsConfig): string | null {
  if (photo.source === 'google_drive' && photo.driveFileId) {
    return `https://drive.google.com/file/d/${photo.driveFileId}/view`;
  }
  if (photo.source === 'local' && config.baseUrl && config.token) {
    return `${config.baseUrl}/originals/${photo.id}?token=${encodeURIComponent(config.token)}`;
  }
  return null;
}

export const originalsConfig: OriginalsConfig = {
  baseUrl: import.meta.env.VITE_ORIGINALS_BASE_URL ?? '',
  token: import.meta.env.VITE_ORIGINALS_TOKEN ?? '',
};
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- originals.test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/services/originals.ts src/vite-env.d.ts .env.example src/services/__tests__/originals.test.ts
git commit -m "Add getOriginalUrl: Drive deep-link or tunnel URL depending on photo source"
```

---

### Task 7: Wire "View Original" into `Search.tsx` and `DailySuggestion.tsx`

**Files:**
- Modify: `src/components/Search.tsx`
- Modify: `src/components/DailySuggestion.tsx`
- Modify: `src/components/__tests__/Search.test.tsx`
- Modify: `src/components/__tests__/DailySuggestion.test.tsx`

**Interfaces:**
- Consumes: `getOriginalUrl`, `originalsConfig` (Task 6).
- Produces: a "View Original" link on each photo card in `Search`, and one on `DailySuggestion`'s pick, rendered only when `getOriginalUrl` returns non-null, opening in a new tab.

- [ ] **Step 1: Add the failing case to `src/components/__tests__/Search.test.tsx`**

```tsx
// add this mock alongside the existing WorkerApiClient mock at the top of the file:
vi.mock('../../services/originals', () => ({
  getOriginalUrl: vi.fn(() => 'https://pixdex-originals.example.com/originals/p1?token=shh'),
}));

// add this test in the existing describe block:
it('shows a "View Original" link when getOriginalUrl resolves one', async () => {
  renderWithProviders(<Search />);
  fireEvent.click(screen.getByRole('button', { name: /search/i }));

  const link = await screen.findByRole('link', { name: /view original/i });
  expect(link).toHaveAttribute('href', 'https://pixdex-originals.example.com/originals/p1?token=shh');
  expect(link).toHaveAttribute('target', '_blank');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- Search.test`
Expected: FAIL — no "View Original" link exists yet.

- [ ] **Step 3: Add the link to `src/components/Search.tsx`**

```tsx
// add to the imports:
import { Link } from '@chakra-ui/react'; // if Link isn't already imported
import { getOriginalUrl, originalsConfig } from '../services/originals';

// inside the results.map(...) card, after the Tag stack:
{(() => {
  const originalUrl = getOriginalUrl(photo, originalsConfig);
  return (
    originalUrl && (
      <Link href={originalUrl} isExternal fontSize="sm" color="teal.500" mt={2} display="inline-block">
        View Original
      </Link>
    )
  );
})()}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- Search.test`
Expected: PASS

- [ ] **Step 5: Repeat for `DailySuggestion.tsx`**

Add the same mock and an equivalent test to `src/components/__tests__/DailySuggestion.test.tsx`, then add to `src/components/DailySuggestion.tsx`, right after the "Copy to Clipboard" button:

```tsx
{(() => {
  const originalUrl = getOriginalUrl(suggestion.photo, originalsConfig);
  return (
    originalUrl && (
      <Link href={originalUrl} isExternal color="teal.500">
        View Original
      </Link>
    )
  );
})()}
```

(with the corresponding `import { Link } from '@chakra-ui/react';` and `import { getOriginalUrl, originalsConfig } from '../services/originals';` additions.)

- [ ] **Step 6: Run the full frontend test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/components/Search.tsx src/components/DailySuggestion.tsx src/components/__tests__/Search.test.tsx src/components/__tests__/DailySuggestion.test.tsx
git commit -m "Add View Original links to Search and DailySuggestion"
```

---

### Task 8: Document the full setup and final verification

**Files:**
- Modify: root `README.md`

**Interfaces:** none — documentation and a full verification pass across all three projects.

- [ ] **Step 1: Add an "Originals (Cloudflare Tunnel)" section to `README.md`**

Insert after the existing "## Setup" section:

```markdown
## Originals (optional)

Search results and the daily pick show thumbnails only by default. To enable
"View Original" for local-disk photos (Drive-sourced photos always deep-link
to Drive, no setup needed), follow `agent/cloudflared/README.md` once, then
set `VITE_ORIGINALS_BASE_URL` and `VITE_ORIGINALS_TOKEN` in this app's `.env`
to match.
```

- [ ] **Step 2: Full verification pass across all three projects**

Run, from the repo root:
```bash
npm test && npm run build
(cd worker && npm test)
(cd agent && npm test)
```
Expected: all pass. This is the last plan in the redesign — a clean pass here means the spec's full scope (local/offline LLM via Ollama, FTS5 search, Google Drive folder-scoped indexing, dedup, Cloudflare-hosted browse UI, and now on-demand originals) is implemented end to end.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Document Cloudflare Tunnel setup for originals"
```

---

## After this plan

Every goal from the spec's motivation section is now implemented:
- **Local/offline** — all AI work (vision analysis, captions, hashtags) runs through Ollama; nothing calls OpenAI.
- **Modern architecture** — a thin, always-reachable Cloudflare Worker (D1 + R2 + FTS5) replaced Express + Prisma + ChromaDB; the local agent replaced the old in-process indexer.
- **Storage-optimized** — content-hash dedup across local drives and Drive, no duplicate re-analysis or re-storage; only thumbnails and metadata ever leave the local machine.
- **Google Drive support** — working, folder-scoped, one-time indexing (not the old untested whole-Drive scan).
- **Full-resolution access from anywhere**, for both sources — Drive via direct deep-link, local-disk via this phase's tunnel.

No further plans are queued. Any future work (e.g. revisiting semantic/vector search if FTS5 + the synonym dictionary proves insufficient in practice, per spec §5's explicitly-deferred option) starts its own brainstorming pass rather than continuing this sequence.
