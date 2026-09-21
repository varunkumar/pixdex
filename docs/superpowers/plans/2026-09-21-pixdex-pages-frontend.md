# Pages Frontend + Old-Stack Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repoint the existing React app at the deployed Cloudflare Worker (search/albums/daily-pick/thumbnails) instead of the old `localhost:3001` Express server, drop the features that no longer have a home in the new architecture (indexing trigger, LLM/storage settings — those are local-agent concerns now), and delete the entire superseded stack (`src/server`, `src/services/llm`, `src/services/indexer`, `src/services/vectorstore`, Prisma, the Chroma docker-compose service) in one shot at the end, once nothing in the repo depends on it anymore.

**Architecture:** The React app (kept as React/Vite/TanStack Query/Chakra — no framework swap, since none was asked for and none of the pain points raised were about the frontend framework) gets one new client, `WorkerApiClient`, that talks directly to the Worker's public routes. Each page component is migrated to it one at a time so the app keeps building and running throughout the phase; the old `ApiClient` and the components/pages that only made sense with the old server (`Settings`, the indexing button and stats on `Dashboard`) are deleted only in the final task, once every consumer has moved off them.

**Tech Stack:** Same as today (React 18, Vite, TanStack Query, Chakra UI, React Router) plus Vitest + React Testing Library + jsdom for component tests — none of which exist yet for the frontend (only `worker/` and `agent/` have test harnesses so far).

**Spec:** `docs/superpowers/specs/2026-09-18-pixdex-local-cloud-redesign-design.md`

**Depends on:** the Cloudflare backend (`docs/superpowers/plans/2026-09-18-pixdex-cloudflare-backend.md`, merged) for its actual, current route surface — verified against `worker/src/routes/*.ts` and `worker/src/db/photos.ts` rather than assumed:
- `GET /search?q=&album=&limit=&offset=` → `{ results: SerializedPhoto[] }`. Only `q` and `album` are real filters today — no subjects/colors/patterns/season/date-range filtering exists on the Worker, so this plan does not build UI for filters the backend can't serve.
- `GET /albums` → `{ albums: string[] }`.
- `GET /photos/:id` → `SerializedPhoto`, 404 if missing.
- `GET /daily-pick` → `{ photo: SerializedPhoto; reason: string; suggestedCaption: string; suggestedHashtags: string[] }`, idempotent per day.
- `GET /thumbnails/:contentHash` → raw JPEG bytes. This is the only image byte endpoint the Worker exposes; there is no full-resolution image route yet (that's the Cloudflare Tunnel phase, still to come) — every image shown in this phase is a thumbnail.
- `SerializedPhoto` (from `worker/src/db/photos.ts`): `{ id, contentHash, source, path, driveFileId, filename, dateTime, width, height, format, fileSize, subjects: unknown[], colors: unknown[], patterns: unknown[], tags: unknown[], season, environment, album, description, suggestedCaption, suggestedHashtags: unknown[], modelProvider, modelName, lastIndexed, instagramSuggested, thumbnailUrl }` — all camelCase, `thumbnailUrl` is a relative path like `/thumbnails/<hash>`.

## Global Constraints

- The web UI is browse/search only. Triggering indexing, and configuring the LLM provider/local paths/Drive credentials, are local-agent concerns now (spec §3) — none of that gets rebuilt here, it gets deleted.
- Search UI only offers what `/search` actually supports: a text query and an album filter. Do not add controls for fields the Worker doesn't accept.
- No image on any page is full-resolution — only `thumbnailUrl` from the Worker. An "open original" action is explicitly out of scope until the Cloudflare Tunnel phase.
- The old stack (`src/server`, `src/services/llm`, `src/services/indexer`, `src/services/vectorstore`, Prisma, Chroma docker-compose) is deleted only once nothing in `src/` imports from it anymore — never partially, never behind a flag.

---

## File Structure

```
vite.config.ts                        # modified — adds Vitest config
package.json                          # modified — adds test deps/script, later strips old-stack deps
.env.example                          # new — VITE_WORKER_API_BASE_URL
src/
  types/
    api.ts                            # new — SerializedPhoto, SearchResponse, DailyPickResponse
    photo.ts                          # deleted in the final task (superseded by types/api.ts)
    config.ts                         # deleted in the final task (AppConfig/LLMConfig — no longer used by the frontend)
  services/
    api/
      WorkerApiClient.ts              # new
      ApiClient.ts                    # deleted in the final task
  components/
    Search.tsx                       # rewritten
    Albums.tsx                       # rewritten
    DailySuggestion.tsx              # rewritten
    Dashboard.tsx                    # rewritten (lightweight home page, no stats/indexing)
    Settings.tsx                     # deleted in the final task
    Navigation.tsx                   # modified — drops the Settings link
  App.tsx                             # modified — drops the /settings route
  server/                             # deleted in the final task
  services/llm/                       # deleted in the final task
  services/indexer/                   # deleted in the final task
  services/vectorstore/               # deleted in the final task
prisma/                               # deleted in the final task
docker-compose.yml                    # deleted in the final task
test/
  setup.ts                           # new — jest-dom matchers
src/**/__tests__ or *.test.tsx        # new, colocated per component
```

---

### Task 1: Set up Vitest + React Testing Library for the frontend

**Files:**
- Modify: `package.json`
- Modify: `vite.config.ts`
- Create: `test/setup.ts`
- Test: `src/components/__tests__/smoke.test.tsx`

**Interfaces:**
- Produces: a working `npm test` for the root app (jsdom environment, `@testing-library/jest-dom` matchers globally available), which every later task in this plan relies on.

- [ ] **Step 1: Add test dependencies to `package.json`**

Add to `devDependencies`:
```json
"@testing-library/jest-dom": "^6.4.0",
"@testing-library/react": "^16.0.0",
"jsdom": "^25.0.0",
"vitest": "^2.1.0"
```

Add to `scripts`:
```json
"test": "vitest run"
```

- [ ] **Step 2: Extend `vite.config.ts` with a `test` block**

```ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    globals: true,
  },
})
```

- [ ] **Step 3: Create `test/setup.ts`**

```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 4: Write the failing test — `src/components/__tests__/smoke.test.tsx`**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

function Hello() {
  return <p>pixdex</p>;
}

describe('frontend test harness', () => {
  it('can render and query a component', () => {
    render(<Hello />);
    expect(screen.getByText('pixdex')).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Run the test**

Run: `npm install && npm test`
Expected: PASS (this proves the harness works before any real component depends on it)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vite.config.ts test/setup.ts src/components/__tests__/smoke.test.tsx
git commit -m "Set up Vitest + React Testing Library for the frontend"
```

---

### Task 2: `WorkerApiClient` + response types

**Files:**
- Create: `src/types/api.ts`
- Create: `src/services/api/WorkerApiClient.ts`
- Create: `.env.example`
- Test: `src/services/api/__tests__/WorkerApiClient.test.ts`

**Interfaces:**
- Produces: `SerializedPhoto`, `SearchResponse`, `DailyPickResponse`, `AlbumsResponse` types in `src/types/api.ts`, matching `worker/src/db/photos.ts`'s `SerializedPhoto` and each route's actual response shape. Produces `WorkerApiClient` class with `search(params: { q?: string; album?: string; limit?: number; offset?: number }): Promise<SerializedPhoto[]>`, `getAlbums(): Promise<string[]>`, `getPhoto(id: string): Promise<SerializedPhoto>`, `getDailyPick(): Promise<DailyPickResponse>`, `thumbnailUrl(photo: Pick<SerializedPhoto, 'thumbnailUrl'>): string`. Also exports a ready-to-use `workerApiClient` singleton built from `import.meta.env.VITE_WORKER_API_BASE_URL`. Consumed by every page component task that follows.

- [ ] **Step 1: Create `.env.example`**

```
VITE_WORKER_API_BASE_URL=https://pixdex-worker.<your-subdomain>.workers.dev
```

- [ ] **Step 2: Declare the env var's type in `src/vite-env.d.ts`**

Without this, `import.meta.env.VITE_WORKER_API_BASE_URL` fails `tsc -b` with "Property does not exist on type 'ImportMetaEnv'". Replace the file's contents with:

```ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WORKER_API_BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

- [ ] **Step 3: Write the failing test — `src/services/api/__tests__/WorkerApiClient.test.ts`**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerApiClient } from '../WorkerApiClient';

describe('WorkerApiClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: WorkerApiClient;

  beforeEach(() => {
    fetchMock = vi.fn();
    client = new WorkerApiClient('https://example.workers.dev', fetchMock as unknown as typeof fetch);
  });

  it('search() builds the query string and returns results', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [{ id: 'p1', thumbnailUrl: '/thumbnails/h1' }] }), { status: 200 })
    );

    const results = await client.search({ q: 'big cat', album: 'Kanha' });

    expect(results).toEqual([{ id: 'p1', thumbnailUrl: '/thumbnails/h1' }]);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.workers.dev/search?q=big+cat&album=Kanha');
  });

  it('getAlbums() returns the albums array', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ albums: ['Kanha', 'Kaziranga'] }), { status: 200 }));
    expect(await client.getAlbums()).toEqual(['Kanha', 'Kaziranga']);
  });

  it('getPhoto() returns the photo or throws on 404', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'p1' }), { status: 200 }));
    expect(await client.getPhoto('p1')).toEqual({ id: 'p1' });

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(client.getPhoto('missing')).rejects.toThrow(/404/);
  });

  it('getDailyPick() returns the daily-pick payload', async () => {
    const payload = { photo: { id: 'p1' }, reason: 'r', suggestedCaption: 'c', suggestedHashtags: ['x'] };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }));
    expect(await client.getDailyPick()).toEqual(payload);
  });

  it('thumbnailUrl() joins the base URL with the relative path', () => {
    expect(client.thumbnailUrl({ thumbnailUrl: '/thumbnails/h1' })).toBe(
      'https://example.workers.dev/thumbnails/h1'
    );
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test -- WorkerApiClient`
Expected: FAIL — `src/services/api/WorkerApiClient.ts` does not exist yet.

- [ ] **Step 5: Create `src/types/api.ts`**

```ts
export interface SerializedPhoto {
  id: string;
  contentHash?: string;
  source?: string;
  path: string | null;
  driveFileId: string | null;
  filename?: string;
  dateTime: string | null;
  width: number | null;
  height: number | null;
  format: string | null;
  fileSize: number | null;
  subjects: string[];
  colors: string[];
  patterns: string[];
  tags: string[];
  season: string | null;
  environment: string | null;
  album: string | null;
  description?: string;
  suggestedCaption?: string;
  suggestedHashtags: string[];
  modelProvider?: string;
  modelName?: string;
  lastIndexed?: string;
  instagramSuggested: string | null;
  thumbnailUrl?: string;
}

export interface SearchResponse {
  results: SerializedPhoto[];
}

export interface AlbumsResponse {
  albums: string[];
}

export interface DailyPickResponse {
  photo: SerializedPhoto;
  reason: string;
  suggestedCaption: string;
  suggestedHashtags: string[];
}
```

- [ ] **Step 6: Create `src/services/api/WorkerApiClient.ts`**

```ts
import type { AlbumsResponse, DailyPickResponse, SearchResponse, SerializedPhoto } from '../../types/api';

export interface SearchParams {
  q?: string;
  album?: string;
  limit?: number;
  offset?: number;
}

export class WorkerApiClient {
  constructor(
    private baseUrl: string,
    private fetchFn: typeof fetch = fetch
  ) {}

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`);
    if (!response.ok) {
      throw new Error(`Request to ${path} failed: ${response.status}`);
    }
    return (await response.json()) as T;
  }

  async search(params: SearchParams): Promise<SerializedPhoto[]> {
    const query = new URLSearchParams();
    if (params.q) query.set('q', params.q);
    if (params.album) query.set('album', params.album);
    if (params.limit != null) query.set('limit', String(params.limit));
    if (params.offset != null) query.set('offset', String(params.offset));

    const suffix = query.toString() ? `?${query.toString()}` : '';
    const { results } = await this.getJson<SearchResponse>(`/search${suffix}`);
    return results;
  }

  async getAlbums(): Promise<string[]> {
    const { albums } = await this.getJson<AlbumsResponse>('/albums');
    return albums;
  }

  async getPhoto(id: string): Promise<SerializedPhoto> {
    return this.getJson<SerializedPhoto>(`/photos/${id}`);
  }

  async getDailyPick(): Promise<DailyPickResponse> {
    return this.getJson<DailyPickResponse>('/daily-pick');
  }

  thumbnailUrl(photo: Pick<SerializedPhoto, 'thumbnailUrl'>): string {
    return `${this.baseUrl}${photo.thumbnailUrl ?? ''}`;
  }
}

export const workerApiClient = new WorkerApiClient(
  import.meta.env.VITE_WORKER_API_BASE_URL ?? ''
);
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm test -- WorkerApiClient`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add .env.example src/vite-env.d.ts src/types/api.ts src/services/api/WorkerApiClient.ts src/services/api/__tests__/WorkerApiClient.test.ts
git commit -m "Add WorkerApiClient talking directly to the Cloudflare Worker"
```

---

### Task 3: Rewrite `Search.tsx`

**Files:**
- Modify: `src/components/Search.tsx`
- Test: `src/components/__tests__/Search.test.tsx`

**Interfaces:**
- Consumes: `workerApiClient` / `WorkerApiClient`, `SerializedPhoto` (Task 2).
- Produces: `Search` component using only `q` and `album` inputs (no more `subjects`/`colors`/etc. fields, since the Worker doesn't support them), rendering thumbnails via `workerApiClient.thumbnailUrl(photo)`.

- [ ] **Step 1: Write the failing test — `src/components/__tests__/Search.test.tsx`**

```tsx
import { ChakraProvider } from '@chakra-ui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Search from '../Search';
import { workerApiClient } from '../../services/api/WorkerApiClient';

vi.mock('../../services/api/WorkerApiClient', async () => {
  const actual = await vi.importActual('../../services/api/WorkerApiClient');
  return {
    ...actual,
    workerApiClient: {
      search: vi.fn(),
      getAlbums: vi.fn(),
      thumbnailUrl: vi.fn((photo: { thumbnailUrl?: string }) => `https://example.workers.dev${photo.thumbnailUrl}`),
    },
  };
});

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <ChakraProvider>{ui}</ChakraProvider>
    </QueryClientProvider>
  );
}

describe('Search', () => {
  beforeEach(() => {
    vi.mocked(workerApiClient.getAlbums).mockResolvedValue(['Kanha']);
    vi.mocked(workerApiClient.search).mockResolvedValue([
      {
        id: 'p1',
        path: null,
        driveFileId: null,
        dateTime: null,
        width: null,
        height: null,
        format: null,
        fileSize: null,
        subjects: ['leopard'],
        colors: [],
        patterns: [],
        tags: ['leopard'],
        season: null,
        environment: null,
        album: 'Kanha',
        description: 'A leopard in a tree.',
        suggestedHashtags: [],
        instagramSuggested: null,
        thumbnailUrl: '/thumbnails/h1',
      },
    ]);
  });

  it('runs a search and renders the results', async () => {
    renderWithProviders(<Search />);

    fireEvent.change(screen.getByPlaceholderText('Search photos...'), {
      target: { value: 'big cat' },
    });
    fireEvent.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => {
      expect(workerApiClient.search).toHaveBeenCalledWith({ q: 'big cat', album: '' });
    });
    expect(await screen.findByText('A leopard in a tree.')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /leopard in a tree/i })).toHaveAttribute(
      'src',
      'https://example.workers.dev/thumbnails/h1'
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- Search.test`
Expected: FAIL — `Search.tsx` still imports the old `ApiClient` and old `SearchCriteria` shape.

- [ ] **Step 3: Rewrite `src/components/Search.tsx`**

```tsx
import {
  Box,
  Button,
  Card,
  CardBody,
  Input as ChakraInput,
  FormControl,
  FormLabel,
  Grid,
  Image,
  Select,
  SimpleGrid,
  Stack,
  Tag,
  Text,
  useToast,
} from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { workerApiClient } from '../services/api/WorkerApiClient';

const Search = () => {
  const [query, setQuery] = useState('');
  const [album, setAlbum] = useState('');
  const toast = useToast();

  const {
    data: results = [],
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['search', query, album],
    queryFn: () => workerApiClient.search({ q: query, album }),
    enabled: false,
  });

  const { data: albums = [] } = useQuery({
    queryKey: ['albums'],
    queryFn: () => workerApiClient.getAlbums(),
  });

  const handleSearch = () => {
    refetch().catch((err) => {
      toast({
        title: 'Search failed',
        description: err.message,
        status: 'error',
        duration: 3000,
      });
    });
  };

  return (
    <Box w="100%">
      <Card mb={8}>
        <CardBody>
          <Stack spacing={4}>
            <Grid templateColumns={{ base: '1fr', md: 'repeat(3, 1fr)' }} gap={4}>
              <FormControl id="album-select">
                <FormLabel>Album</FormLabel>
                <Select
                  aria-label="Select photo album"
                  name="album"
                  placeholder="Select Album"
                  value={album}
                  onChange={(e) => setAlbum(e.target.value)}
                >
                  {albums.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </Select>
              </FormControl>
              <FormControl>
                <FormLabel>Search</FormLabel>
                <ChakraInput
                  placeholder="Search photos..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleSearch();
                    }
                  }}
                />
              </FormControl>
              <Box pt={{ base: 0, md: 8 }}>
                <Button w="100%" colorScheme="teal" onClick={handleSearch} isLoading={isLoading}>
                  Search
                </Button>
              </Box>
            </Grid>
          </Stack>
        </CardBody>
      </Card>

      {error && (
        <Text color="red.500">{error instanceof Error ? error.message : 'An error occurred'}</Text>
      )}

      <SimpleGrid columns={[1, 2, 3]} spacing={4}>
        {results.map((photo) => (
          <Box key={photo.id} borderWidth={1} borderRadius="lg" overflow="hidden">
            <Image
              src={workerApiClient.thumbnailUrl(photo)}
              alt={photo.description ?? photo.filename ?? photo.id}
              objectFit="cover"
              height="200px"
              width="100%"
            />
            <Box p={4}>
              <Text fontSize="sm" mb={2}>
                {photo.description}
              </Text>
              <Stack direction="row" flexWrap="wrap" gap={2}>
                {photo.tags.map((tag) => (
                  <Tag key={tag} size="sm">
                    {tag}
                  </Tag>
                ))}
              </Stack>
            </Box>
          </Box>
        ))}
      </SimpleGrid>
    </Box>
  );
};

export default Search;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- Search.test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/Search.tsx src/components/__tests__/Search.test.tsx
git commit -m "Rewrite Search to call WorkerApiClient (q + album only)"
```

---

### Task 4: Rewrite `Albums.tsx` (browse-only)

**Files:**
- Modify: `src/components/Albums.tsx`
- Test: `src/components/__tests__/Albums.test.tsx`

**Interfaces:**
- Consumes: `workerApiClient.getAlbums()` (Task 2).
- Produces: `Albums` component listing album names as links to `/search?album=<name>` (Search reads the album from the URL query param — see Step 3's addition to `Search.tsx`). Drops `clearAlbumIndex`/`clearAllIndices`, since the Worker has no delete routes and album management is not a web-UI concern per the spec.

- [ ] **Step 1: Write the failing test — `src/components/__tests__/Albums.test.tsx`**

```tsx
import { ChakraProvider } from '@chakra-ui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Albums from '../Albums';
import { workerApiClient } from '../../services/api/WorkerApiClient';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: { getAlbums: vi.fn() },
}));

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <ChakraProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ChakraProvider>
    </QueryClientProvider>
  );
}

describe('Albums', () => {
  beforeEach(() => {
    vi.mocked(workerApiClient.getAlbums).mockResolvedValue(['Kanha 2026', 'Kaziranga 2026']);
  });

  it('lists albums as links into Search', async () => {
    renderWithProviders(<Albums />);

    const link = await screen.findByRole('link', { name: 'Kanha 2026' });
    expect(link).toHaveAttribute('href', '/search?album=Kanha+2026');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- Albums.test`
Expected: FAIL — `Albums.tsx` still calls the old `apiClient`.

- [ ] **Step 3: Rewrite `src/components/Albums.tsx`**

```tsx
import { Box, Card, CardBody, Grid, Heading, Link, Text, VStack } from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { Link as RouterLink } from 'react-router-dom';
import { workerApiClient } from '../services/api/WorkerApiClient';

const Albums = () => {
  const { data: albums = [] } = useQuery({
    queryKey: ['albums'],
    queryFn: () => workerApiClient.getAlbums(),
  });

  return (
    <VStack spacing={6} align="stretch" w="100%">
      <Box>
        <Heading size="lg">Albums</Heading>
      </Box>

      <Grid templateColumns="repeat(auto-fill, minmax(300px, 1fr))" gap={6}>
        {albums.map((album) => (
          <Link
            key={album}
            as={RouterLink}
            to={`/search?album=${encodeURIComponent(album)}`}
            textDecoration="none"
            _hover={{ textDecoration: 'none' }}
          >
            <Card>
              <CardBody>
                <Text fontSize="lg">{album}</Text>
              </CardBody>
            </Card>
          </Link>
        ))}
      </Grid>
    </VStack>
  );
};

export default Albums;
```

- [ ] **Step 4: Add URL-driven album prefill to `src/components/Search.tsx`**

```ts
// add near the top of the component body, alongside the existing useState calls:
import { useSearchParams } from 'react-router-dom';
// ...
const [searchParams] = useSearchParams();
const [album, setAlbum] = useState(searchParams.get('album') ?? '');
```

`Search` now reads route context (`useSearchParams`), which requires a Router ancestor — something Task 3's test for `Search.tsx` didn't provide. Fix that in the same step, or Task 3's previously-passing test breaks here:

- [ ] **Step 5: Wrap `src/components/__tests__/Search.test.tsx`'s render helper in a Router**

```tsx
// add this import alongside the existing ones:
import { MemoryRouter } from 'react-router-dom';

// change renderWithProviders to:
function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <ChakraProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ChakraProvider>
    </QueryClientProvider>
  );
}
```

- [ ] **Step 6: Run both affected test suites to verify they pass**

Run: `npm test -- Search.test Albums.test`
Expected: PASS for both — this confirms Task 3's test still works with the Router requirement Task 4 just introduced.

- [ ] **Step 7: Commit**

```bash
git add src/components/Albums.tsx src/components/Search.tsx src/components/__tests__/Albums.test.tsx src/components/__tests__/Search.test.tsx
git commit -m "Rewrite Albums as a browse-only list linking into Search"
```

---

### Task 5: Rewrite `DailySuggestion.tsx`

**Files:**
- Modify: `src/components/DailySuggestion.tsx`
- Test: `src/components/__tests__/DailySuggestion.test.tsx`

**Interfaces:**
- Consumes: `workerApiClient.getDailyPick()` (Task 2).
- Produces: `DailySuggestion` component showing the thumbnail (not full-res — see Global Constraints), reason, pre-generated caption, and hashtags, with the existing "copy to clipboard" behavior kept as-is (it doesn't touch the old server).

- [ ] **Step 1: Write the failing test — `src/components/__tests__/DailySuggestion.test.tsx`**

```tsx
import { ChakraProvider } from '@chakra-ui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DailySuggestion from '../DailySuggestion';
import { workerApiClient } from '../../services/api/WorkerApiClient';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: { getDailyPick: vi.fn(), thumbnailUrl: vi.fn(() => 'https://example.workers.dev/thumbnails/h1') },
}));

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <ChakraProvider>{ui}</ChakraProvider>
    </QueryClientProvider>
  );
}

describe('DailySuggestion', () => {
  beforeEach(() => {
    vi.mocked(workerApiClient.getDailyPick).mockResolvedValue({
      photo: { id: 'p1', thumbnailUrl: '/thumbnails/h1' } as any,
      reason: 'It features a leopard in a forest setting.',
      suggestedCaption: 'Golden hour, golden coat.',
      suggestedHashtags: ['leopard', 'wildlife'],
    });
  });

  it('renders the daily pick with its pre-generated caption and hashtags', async () => {
    renderWithProviders(<DailySuggestion />);

    expect(await screen.findByText('Golden hour, golden coat.')).toBeInTheDocument();
    expect(screen.getByText('#leopard')).toBeInTheDocument();
    expect(screen.getByText('It features a leopard in a forest setting.')).toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAttribute('src', 'https://example.workers.dev/thumbnails/h1');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- DailySuggestion.test`
Expected: FAIL — still uses the old `apiClient` and `localhost:3001` image URL.

- [ ] **Step 3: Rewrite `src/components/DailySuggestion.tsx`**

```tsx
import {
  Box,
  Button,
  Card,
  CardBody,
  CardHeader,
  Flex,
  Heading,
  Image,
  Skeleton,
  Tag,
  Text,
  Textarea,
  useToast,
  VStack,
} from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { workerApiClient } from '../services/api/WorkerApiClient';

const DailySuggestion = () => {
  const toast = useToast();

  const {
    data: suggestion,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['dailyPick'],
    queryFn: () => workerApiClient.getDailyPick(),
  });

  const handleCopyToClipboard = () => {
    if (!suggestion) return;

    const content = `${suggestion.suggestedCaption}\n\n${suggestion.suggestedHashtags
      .map((tag) => `#${tag}`)
      .join(' ')}`;
    navigator.clipboard.writeText(content).then(
      () => {
        toast({ title: 'Copied to clipboard', status: 'success', duration: 2000 });
      },
      (err) => {
        toast({ title: 'Failed to copy', description: err.message, status: 'error', duration: 3000 });
      }
    );
  };

  return (
    <Box w="100%" maxW="container.xl" mx="auto">
      <Card>
        <CardHeader>
          <Heading size="md">Today's Instagram Pick</Heading>
        </CardHeader>
        <CardBody>
          {isLoading ? (
            <VStack spacing={4} align="stretch">
              <Skeleton height="400px" />
              <Skeleton height="20px" />
              <Skeleton height="100px" />
              <Skeleton height="40px" />
            </VStack>
          ) : error ? (
            <Text color="red.500">
              {error instanceof Error ? error.message : 'An error occurred while loading the suggestion'}
            </Text>
          ) : suggestion ? (
            <VStack spacing={4} align="stretch">
              <Image
                src={workerApiClient.thumbnailUrl(suggestion.photo)}
                alt={suggestion.photo.description ?? suggestion.photo.filename ?? suggestion.photo.id}
                borderRadius="lg"
                objectFit="cover"
                maxH="500px"
              />

              <Text fontWeight="bold">Why this photo?</Text>
              <Text>{suggestion.reason}</Text>

              <Text fontWeight="bold">Suggested Caption</Text>
              <Textarea value={suggestion.suggestedCaption} isReadOnly rows={4} />

              <Text fontWeight="bold">Suggested Hashtags</Text>
              <Flex gap={2} flexWrap="wrap">
                {suggestion.suggestedHashtags.map((tag) => (
                  <Tag key={tag} colorScheme="teal">
                    #{tag}
                  </Tag>
                ))}
              </Flex>

              <Button colorScheme="teal" onClick={handleCopyToClipboard}>
                Copy to Clipboard
              </Button>
            </VStack>
          ) : (
            <Text>No suggestion available</Text>
          )}
        </CardBody>
      </Card>
    </Box>
  );
};

export default DailySuggestion;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- DailySuggestion.test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/DailySuggestion.tsx src/components/__tests__/DailySuggestion.test.tsx
git commit -m "Rewrite DailySuggestion to call WorkerApiClient"
```

---

### Task 6: Rewrite `Dashboard.tsx` as a lightweight home page; update `Navigation.tsx`/`App.tsx`

**Files:**
- Modify: `src/components/Dashboard.tsx`
- Modify: `src/components/Navigation.tsx`
- Modify: `src/App.tsx`
- Test: `src/components/__tests__/Dashboard.test.tsx`

**Interfaces:**
- Consumes: `workerApiClient.getAlbums()` (Task 2) for a simple album count; no stats endpoint exists on the Worker, so per-subject/per-location counts are dropped rather than invented.
- Produces: `Dashboard` as a home page with nav shortcuts to Search/Albums/Daily Pick — no indexing button, no cache/LLM stats (those were server-side concerns that no longer exist in the web UI). `Navigation` drops its `/settings` link. `App` drops the `/settings` route.

- [ ] **Step 1: Write the failing test — `src/components/__tests__/Dashboard.test.tsx`**

```tsx
import { ChakraProvider } from '@chakra-ui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Dashboard from '../Dashboard';
import { workerApiClient } from '../../services/api/WorkerApiClient';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: { getAlbums: vi.fn() },
}));

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <ChakraProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ChakraProvider>
    </QueryClientProvider>
  );
}

describe('Dashboard', () => {
  beforeEach(() => {
    vi.mocked(workerApiClient.getAlbums).mockResolvedValue(['Kanha', 'Kaziranga']);
  });

  it('shows the album count and links to Search/Albums/Daily Pick, with no indexing controls', async () => {
    renderWithProviders(<Dashboard />);

    expect(await screen.findByText('2')).toBeInTheDocument(); // album count
    expect(screen.getByRole('link', { name: /search/i })).toHaveAttribute('href', '/search');
    expect(screen.getByRole('link', { name: /albums/i })).toHaveAttribute('href', '/albums');
    expect(screen.getByRole('link', { name: /daily pick/i })).toHaveAttribute('href', '/daily');
    expect(screen.queryByRole('button', { name: /index photos/i })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- Dashboard.test`
Expected: FAIL — `Dashboard.tsx` still shows the old stats grid and indexing button.

- [ ] **Step 3: Rewrite `src/components/Dashboard.tsx`**

```tsx
import { Card, CardBody, CardHeader, Grid, Heading, Link, Stat, StatLabel, StatNumber, VStack } from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { Link as RouterLink } from 'react-router-dom';
import { workerApiClient } from '../services/api/WorkerApiClient';

const Dashboard = () => {
  const { data: albums = [] } = useQuery({
    queryKey: ['albums'],
    queryFn: () => workerApiClient.getAlbums(),
  });

  return (
    <VStack spacing={6} align="stretch" w="100%">
      <Card>
        <CardHeader>
          <Heading size="md">pixdex</Heading>
        </CardHeader>
        <CardBody>
          <Link as={RouterLink} to="/albums" textDecoration="none" _hover={{ textDecoration: 'none' }}>
            <Stat cursor="pointer">
              <StatLabel>Albums</StatLabel>
              <StatNumber>{albums.length}</StatNumber>
            </Stat>
          </Link>
        </CardBody>
      </Card>

      <Grid templateColumns={{ base: '1fr', md: 'repeat(3, 1fr)' }} gap={4}>
        <Link as={RouterLink} to="/search">
          <Card>
            <CardBody>Search</CardBody>
          </Card>
        </Link>
        <Link as={RouterLink} to="/albums">
          <Card>
            <CardBody>Albums</CardBody>
          </Card>
        </Link>
        <Link as={RouterLink} to="/daily">
          <Card>
            <CardBody>Daily Pick</CardBody>
          </Card>
        </Link>
      </Grid>
    </VStack>
  );
};

export default Dashboard;
```

- [ ] **Step 4: Drop the Settings link from `src/components/Navigation.tsx`**

Remove the `MdSettings` import and the `<Link as={RouterLink} to="/settings" ...>` block entirely; everything else in the file is unchanged.

- [ ] **Step 5: Drop the `/settings` route from `src/App.tsx`**

Remove the `import Settings from './components/Settings';` line and the `<Route path="/settings" element={<Settings />} />` line; everything else is unchanged.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- Dashboard.test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/components/Dashboard.tsx src/components/Navigation.tsx src/App.tsx src/components/__tests__/Dashboard.test.tsx
git commit -m "Simplify Dashboard to a home page; drop the Settings route"
```

---

### Task 7: Cutover — delete the old stack

**Files:**
- Delete: `src/server/`
- Delete: `src/services/llm/`
- Delete: `src/services/indexer/`
- Delete: `src/services/vectorstore/`
- Delete: `src/services/api/ApiClient.ts`
- Delete: `src/components/Settings.tsx`
- Delete: `src/types/config.ts`
- Delete: `src/types/photo.ts`
- Delete: `prisma/`
- Delete: `docker-compose.yml`
- Modify: `package.json`

**Interfaces:** none produced — this is pure deletion, verified by a grep sweep and a full build/test pass at the end.

- [ ] **Step 1: Confirm nothing still imports the files being deleted**

Run: `grep -rn "from '.*services/api/ApiClient'\|from '.*components/Settings'\|from '.*types/config'\|from '.*types/photo'\|from '.*services/llm\|from '.*services/indexer\|from '.*services/vectorstore" src/`
Expected: no matches (Tasks 3-6 already moved every consumer to `WorkerApiClient/types/api`). If anything matches, finish migrating that file before continuing — do not delete out from under a live import.

- [ ] **Step 2: Delete the old stack**

```bash
git rm -r src/server src/services/llm src/services/indexer src/services/vectorstore prisma docker-compose.yml
git rm src/services/api/ApiClient.ts src/components/Settings.tsx src/types/config.ts src/types/photo.ts
```

- [ ] **Step 3: Strip now-dead scripts and dependencies from `package.json`**

Remove these scripts (server/local-DB/Chroma orchestration, all superseded — indexing runs through `agent/` now, search runs through `worker/`):
```json
"server": "tsx watch src/server/index.ts",
"chroma:up": "docker-compose up -d chromadb",
"chroma:down": "docker-compose down",
"chroma:logs": "docker-compose logs -f chromadb",
"start": "npm run chroma:up && npm run dev"
```

Remove these dependencies (each was only reachable from files just deleted — confirm with `grep -rn "<package-name>" src/` returning nothing before removing each one): `@google-cloud/storage`, `@prisma/client`, `chromadb`, `cors`, `dotenv`, `exiftool-vendored`, `express`, `google-auth-library`, `googleapis`, `langchain`, `mime-types`, `multer`, `openai`, `prisma`. Also remove their matching `@types/*` devDependencies (`@types/cors`, `@types/express`, `@types/mime-types`, `@types/multer`) and `concurrently` if nothing else in `package.json` scripts still uses it (check the final `scripts` block).

Run: `npm install` (from the repo root) after editing, to regenerate `package-lock.json` for the trimmed dependency set.

- [ ] **Step 4: Full verification pass**

Run, from the repo root:
```bash
npm run build
npm test
npm run lint
```
Expected: all three pass. `build` proves nothing references a deleted module; `test` re-runs every component test from Tasks 1-6; `lint` catches any now-unused import ESLint would flag.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "Delete the old Express/Prisma/Chroma/OpenAI stack — superseded by worker/ and agent/"
```

---

## After this plan

The web app now runs entirely against the Cloudflare Worker: browsing, searching, and the daily pick all work whether or not the local machine is on. Indexing (local or Drive) happens exclusively through `agent/`. The only plan remaining, per the spec:

1. **Cloudflare Tunnel for originals** — a small addition to `agent/` that serves already-indexed local-disk originals on demand, plus an "open original" action in the frontend (Drive-sourced photos can deep-link to Drive directly, no tunnel needed for those).
