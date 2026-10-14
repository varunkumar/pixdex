# PixdeX UI Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the PixdeX frontend to Mantine 9 on a current dependency set and ship URL-driven state, pagination, rich albums, a separate album page, a responsive header, the Aurora theme and a photo lightbox.

**Architecture:** Phase 0 bumps dependencies while still on Chakra 2. Phase 1 adds Mantine alongside Chakra and ports the shell (layout, router, theme) so pages can be migrated one at a time with a green build at every commit. Phase 2 adds the worker endpoints and rewrites Search, Albums, Dashboard and PhotoDetail directly on Mantine, then removes Chakra.

**Tech Stack:** React 19, react-router-dom 7 (data router), Mantine 9 (`@mantine/core`, `@mantine/hooks`, `@mantine/notifications`), TanStack Query 5, Vite 8, Vitest 5, Hono + D1 (worker), `react-icons/md`.

**Spec:** `docs/superpowers/specs/2026-10-14-pixdex-ui-overhaul-design.md`

## Deviations from the spec (decided while planning)

These supersede the spec; Task 14 updates the spec text to match.

1. Search and Albums are not ported 1:1 first. They are rewritten directly on Mantine in Phase 2, because they change completely anyway. Dashboard and PhotoDetail are likewise ported and extended in one step.
2. `/search` with no params runs the search and lists everything newest first (paginated), instead of showing a prompt state. This keeps "click Search with an empty box" working as it does today.
3. There is no `/search?album=X` to `/albums/X` redirect. Search keeps an album filter dropdown, so `album` without `q` is a legitimate Search state. Internal links are updated to `/albums/:name` instead.
4. Mantine 7+ has no `ColorSchemeProvider`. Colour scheme is `MantineProvider defaultColorScheme="auto"` plus `useMantineColorScheme`.

## Global Constraints

- Brand text is exactly `PixdeX`. Lowercase `pixdex` only where it is an identifier (package name, repo, paths, test ids).
- Never use em dashes (U+2014) in code, copy, comments or docs. Use commas, colons, parentheses or hyphens.
- Keep `react-icons/md` for icons (`MdHome`, `MdAlbum`, `MdSearch`, `MdPhoto`, `MdLogout` retained).
- Aurora tokens: primary `#0E8F9A`, gradient mid `#2563EB`, gradient end `#7C3AED`, accent `#22D3EE`, light surface `#F4FAFD`, dark surface `#0B1620`.
- Fonts: Bricolage Grotesque (display), DM Sans (body), with system fallbacks.
- Search page size options 10, 20, 50 (default 10). Album page size options 12, 24, 48 (default 12). Worker maximum `limit` stays 100 for `/search` and is 48 for `/albums`.
- Worker `/search` ordering is unchanged by default (`bm25`, then `last_indexed DESC`).
- Every frontend commit passes the pre-commit gate (`npm run lint`, `npm test`, `npm run build`). Worker commits pass `cd worker && npm test`.
- Work on branch `ui-overhaul`.

## Review Focus

1. `page=999`, `page=0`, `page=abc` or `size=7` in the URL: clamp to the last page, 1 and the default size, never a blank or crashing page.
2. Album names containing `/`, `?`, `#`, `%`, `&` or non-ASCII: the card link, album page and Search filter round-trip them exactly.
3. Album with no thumbnail or a `null` date: card renders a placeholder and no date, no crash.
4. Original 502 (machine offline), non-image original or a Google Drive photo: detail page and lightbox still work, showing the thumbnail and an "Open original" link; `?lightbox=1` on such a photo is safe.
5. Whitespace-only query `q=%20%20`: treated as empty (lists everything) rather than sent to the worker as a query.
6. Empty library: `/albums` and `/search` show an empty state, Dashboard shows 0 photos and 0 albums.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/theme.ts` (new) | `BRAND`, `HEADER_GRADIENT`, Mantine `theme` (Aurora) |
| `src/test/renderWithProviders.tsx` (new) | Test providers (Mantine, Query, Notifications) with `MemoryRouter` and data-router variants |
| `src/test/fixtures.ts` (new) | `makePhoto()` fixture |
| `src/components/Layout.tsx` (new) | AppShell header, burger and drawer navbar, colour scheme toggle, `Outlet` |
| `src/components/Navigation.tsx` (delete) | Replaced by `Layout.tsx` |
| `src/hooks/useListParams.ts` (new) | URL-backed `page`/`size` plus param patching |
| `src/hooks/usePrefetchImage.ts` (new) | Preload an image URL, report status |
| `src/components/ListPagination.tsx` (new) | Range text, Mantine `Pagination`, size select, out-of-range clamp |
| `src/components/PhotoCard.tsx`, `PhotoGrid.tsx` (new) | Shared photo listing cells |
| `src/components/Search.tsx` (rewrite) | URL-driven, paginated search |
| `src/components/Albums.tsx` (rewrite), `AlbumCard.tsx` (new) | Paginated rich album grid |
| `src/components/AlbumPhotos.tsx` (new) | `/albums/:name` photo listing |
| `src/components/Lightbox.tsx` (new) | Fullscreen modal with original, fallback |
| `src/components/PhotoDetail.tsx`, `Dashboard.tsx`, `DailySuggestion.tsx`, `PhotoMeta.tsx` | Ported to Mantine and extended |
| `src/services/originals.ts` | Adds `getOriginalImageUrl` |
| `src/services/api/WorkerApiClient.ts`, `src/types/api.ts` | Rich albums, names mode, `sort` |
| `worker/src/routes/photos.ts`, `worker/src/routes/search.ts` | Rich `/albums`, `sort=date` |

---

## Phase 0: Dependency bump (still on Chakra 2)

### Task 1: Bump the root dependencies

**Files:**
- Modify: `package.json`, `package-lock.json`
- Modify (only if the upgrade requires it): `eslint.config.js`, `tsconfig*.json`, `vite.config.ts`, `src/**/*.tsx`

**Interfaces:**
- Produces: a green `npm test && npm run lint && npm run build` on React 19, react-router-dom 7, Vite 8, Vitest 5.

- [ ] **Step 1: Record the baseline**

Run: `cd /Users/varunkumar/repos/pixdex && git checkout ui-overhaul && npm ci && npm test && npm run lint && npm run build`
Expected: all three pass. If anything fails here, stop and report; do not start bumping on a red baseline.

- [ ] **Step 2: Bump runtime dependencies**

```bash
npm install react@latest react-dom@latest react-router-dom@latest @tanstack/react-query@latest react-icons@latest framer-motion@latest
npm install -D @types/react@latest @types/react-dom@latest vite@latest @vitejs/plugin-react@latest vitest@latest jsdom@latest @testing-library/react@latest @testing-library/jest-dom@latest
```

`framer-motion` is bumped only so Chakra 2 resolves against React 19 without `--legacy-peer-deps`; it is removed in Task 14.
Expected: install succeeds with no `ERESOLVE`. If `ERESOLVE` names another package, bump that package to its latest too.

- [ ] **Step 3: Bump the toolchain**

```bash
npm install -D typescript@latest typescript-eslint@latest eslint@latest @eslint/js@latest eslint-plugin-react-hooks@latest eslint-plugin-react-refresh@latest @types/node@latest
```

Rule: if `typescript-eslint` does not yet support the newest `typescript` (peer dependency error or parser crash), install the newest `typescript` that its peer range allows (for example `typescript@5.9`) and record this in the commit message. Same rule for `eslint`.

- [ ] **Step 4: Run everything and fix breakages**

Run: `npm test && npm run lint && npm run build`
Expected: PASS. Known hotspots to check first when something fails:
- React 19 types: the global `JSX` namespace and `React.ReactElement` references in `src/components/__tests__/*.tsx`. Replace with `import type { ReactElement } from 'react'`.
- `eslint-plugin-react-hooks` 7 adds new rules (for example `react-hooks/set-state-in-effect`). Fix real violations; do not disable rules wholesale.
- Vitest 5 config: `test.include` and `setupFiles` in `vite.config.ts` stay as they are; if the `/// <reference types="vitest/config" />` line errors, keep it and bump `@types/node`.

- [ ] **Step 5: Verify the agent and worker are untouched**

Run: `git status --short`
Expected: only the root `package.json`, `package-lock.json` and files under `src/`, `eslint.config.js`, `tsconfig*.json`, `vite.config.ts` changed.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Upgrade React, router, Vite, Vitest and toolchain to latest

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Phase 1: Mantine foundation

### Task 2: Install Mantine, theme, test helpers

**Files:**
- Create: `src/theme.ts`, `src/test/renderWithProviders.tsx`, `src/test/fixtures.ts`, `src/__tests__/theme.test.ts`
- Modify: `package.json`, `test/setup.ts`, `src/App.tsx`, `src/main.tsx`, `index.html`

**Interfaces:**
- Produces:
  - `src/theme.ts`: `export const BRAND = 'PixdeX'`, `export const HEADER_GRADIENT: string`, `export const theme: MantineThemeOverride`
  - `renderWithProviders(ui: ReactElement, opts?: { route?: string; path?: string }): RenderResult`
  - `renderWithRouter(routes: RouteObject[], initialEntries: string[]): RenderResult & { router: ReturnType<typeof createMemoryRouter> }`
  - `makePhoto(overrides?: Partial<SerializedPhoto>): SerializedPhoto`

- [ ] **Step 1: Install**

```bash
npm install @mantine/core@latest @mantine/hooks@latest @mantine/notifications@latest
```

Expected: success. Note the installed Mantine major in the commit message; if it is not 9, still proceed but read its migration notes for `AppShell`, `Pagination` and `Modal` prop names before Task 3.

- [ ] **Step 2: Write the failing theme test**

`src/__tests__/theme.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BRAND, HEADER_GRADIENT, theme } from '../theme';

describe('theme', () => {
  it('names the product PixdeX', () => {
    expect(BRAND).toBe('PixdeX');
  });

  it('uses the Aurora gradient and primary colour', () => {
    expect(HEADER_GRADIENT).toContain('#0E8F9A');
    expect(HEADER_GRADIENT).toContain('#2563EB');
    expect(HEADER_GRADIENT).toContain('#7C3AED');
    expect(theme.primaryColor).toBe('aurora');
    expect(theme.colors?.aurora).toHaveLength(10);
    expect(theme.colors?.aurora?.[6]).toBe('#0E8F9A');
  });
});
```

- [ ] **Step 3: Run it, expect failure**

Run: `npx vitest run src/__tests__/theme.test.ts`
Expected: FAIL (cannot resolve `../theme`).

- [ ] **Step 4: Write `src/theme.ts`**

```ts
import { createTheme, type MantineColorsTuple } from '@mantine/core';

export const BRAND = 'PixdeX';

// Ten shades around the Aurora teal; index 6 is the primary shade in light mode.
const aurora: MantineColorsTuple = [
  '#E6FAFB',
  '#C9F2F5',
  '#9DE6EB',
  '#6DD8DF',
  '#3FC6CF',
  '#1FB2BD',
  '#0E8F9A',
  '#0B747D',
  '#085C64',
  '#05444A',
];

export const HEADER_GRADIENT = 'linear-gradient(100deg, #0E8F9A, #2563EB 55%, #7C3AED)';

export const theme = createTheme({
  primaryColor: 'aurora',
  colors: { aurora },
  fontFamily: "'DM Sans', system-ui, -apple-system, 'Segoe UI', sans-serif",
  headings: {
    fontFamily: "'Bricolage Grotesque', 'Segoe UI', system-ui, sans-serif",
    fontWeight: '700',
  },
  defaultRadius: 'md',
  defaultGradient: { from: '#0E8F9A', to: '#7C3AED', deg: 100 },
});
```

- [ ] **Step 5: Run the theme test, expect pass**

Run: `npx vitest run src/__tests__/theme.test.ts`
Expected: PASS.

- [ ] **Step 6: Add jsdom shims that Mantine needs**

Append to `test/setup.ts`:

```ts
import { vi } from 'vitest';

// Mantine reads matchMedia and ResizeObserver; jsdom has neither.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
```

- [ ] **Step 7: Write the test helpers**

`src/test/renderWithProviders.tsx`:

```tsx
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import {
  createMemoryRouter,
  MemoryRouter,
  Route,
  RouterProvider,
  Routes,
  type RouteObject,
} from 'react-router-dom';
import { theme } from '../theme';

function Providers({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <MantineProvider theme={theme} env="test">
        <Notifications />
        {children}
      </MantineProvider>
    </QueryClientProvider>
  );
}

export function renderWithProviders(ui: ReactElement, opts: { route?: string; path?: string } = {}) {
  const { route = '/', path } = opts;
  const tree = path ? (
    <Routes>
      <Route path={path} element={ui} />
    </Routes>
  ) : (
    ui
  );
  return render(
    <Providers>
      <MemoryRouter initialEntries={[route]}>{tree}</MemoryRouter>
    </Providers>
  );
}

/** For tests that need real history (back/forward) or location state. */
export function renderWithRouter(routes: RouteObject[], initialEntries: string[]) {
  const router = createMemoryRouter(routes, { initialEntries });
  const utils = render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  );
  return { router, ...utils };
}
```

`src/test/fixtures.ts`:

```ts
import type { SerializedPhoto } from '../types/api';

export function makePhoto(overrides: Partial<SerializedPhoto> = {}): SerializedPhoto {
  return {
    id: 'p1',
    path: null,
    driveFileId: null,
    source: 'local',
    filename: 'DSC_0001.jpg',
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
    description: 'A leopard in a tree.',
    suggestedHashtags: [],
    instagramSuggested: null,
    thumbnailUrl: '/thumbnails/h1',
    ...overrides,
  };
}
```

- [ ] **Step 8: Provide Mantine next to Chakra**

In `src/App.tsx`, wrap the existing tree (keep `ChakraProvider` for now):

```tsx
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { theme } from './theme';
// ...inside App(), outermost element:
<MantineProvider theme={theme} defaultColorScheme="auto">
  <Notifications />
  <ChakraProvider>{/* existing tree unchanged */}</ChakraProvider>
</MantineProvider>
```

In `src/main.tsx` add before `./index.css`:

```ts
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
```

In `index.html` `<head>`, add:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@600;700&family=DM+Sans:wght@400;500;600&display=swap"
  rel="stylesheet"
/>
```

- [ ] **Step 9: Verify**

Run: `npm test && npm run lint && npm run build`
Expected: PASS (existing Chakra tests still pass; Mantine only adds providers).

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "Add Mantine, Aurora theme and shared test helpers

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 3: Layout, header and data router

**Files:**
- Create: `src/components/Layout.tsx`, `src/components/__tests__/Layout.test.tsx`
- Delete: `src/components/Navigation.tsx`
- Modify: `src/App.tsx`, `src/components/__tests__/smoke.test.tsx` (keep as is unless it imports Navigation)

**Interfaces:**
- Consumes: `BRAND`, `HEADER_GRADIENT` from `src/theme.ts`; `renderWithProviders`.
- Produces: default export `Layout` (renders header, drawer navbar and an `<Outlet />`); `App` builds the data router with `ScrollRestoration`.

- [ ] **Step 1: Write the failing test**

`src/components/__tests__/Layout.test.tsx`:

```tsx
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../test/renderWithProviders';
import Layout from '../Layout';

describe('Layout', () => {
  it('shows the PixdeX brand linking home', () => {
    renderWithProviders(<Layout />);
    const brand = screen.getAllByRole('link', { name: 'PixdeX' })[0];
    expect(brand).toHaveAttribute('href', '/');
  });

  it('links to every section', () => {
    renderWithProviders(<Layout />);
    const hrefFor = (name: string) =>
      screen.getAllByRole('link', { name }).map((l) => l.getAttribute('href'));
    expect(hrefFor('Dashboard')).toContain('/');
    expect(hrefFor('Albums')).toContain('/albums');
    expect(hrefFor('Search')).toContain('/search');
    expect(hrefFor('Daily Pick')).toContain('/daily');
  });

  it('offers log out and a burger for narrow screens', () => {
    renderWithProviders(<Layout />);
    expect(screen.getAllByRole('link', { name: /log out/i })[0]).toHaveAttribute(
      'href',
      '/cdn-cgi/access/logout'
    );
    expect(screen.getByRole('button', { name: /toggle navigation/i })).toBeInTheDocument();
  });

  it('has a colour scheme toggle', () => {
    renderWithProviders(<Layout />);
    expect(screen.getByRole('button', { name: /toggle colour scheme/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run src/components/__tests__/Layout.test.tsx`
Expected: FAIL (cannot resolve `../Layout`).

- [ ] **Step 3: Write `src/components/Layout.tsx`**

```tsx
import {
  ActionIcon,
  AppShell,
  Burger,
  Button,
  Container,
  Group,
  NavLink,
  Text,
  useComputedColorScheme,
  useMantineColorScheme,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { MdAlbum, MdDarkMode, MdHome, MdLightMode, MdLogout, MdPhoto, MdSearch } from 'react-icons/md';
import { Link, NavLink as RouterNavLink, Outlet } from 'react-router-dom';
import { BRAND, HEADER_GRADIENT } from '../theme';

const LINKS = [
  { to: '/', label: 'Dashboard', icon: MdHome, end: true },
  { to: '/albums', label: 'Albums', icon: MdAlbum, end: false },
  { to: '/search', label: 'Search', icon: MdSearch, end: false },
  { to: '/daily', label: 'Daily Pick', icon: MdPhoto, end: false },
];

const Layout = () => {
  const [opened, { toggle, close }] = useDisclosure(false);
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme('light');

  return (
    <AppShell
      header={{ height: 60 }}
      navbar={{ width: 260, breakpoint: 'sm', collapsed: { desktop: true, mobile: !opened } }}
      padding="md"
    >
      <AppShell.Header style={{ background: HEADER_GRADIENT, border: 'none' }}>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="md" wrap="nowrap">
            <Burger
              opened={opened}
              onClick={toggle}
              hiddenFrom="sm"
              size="sm"
              color="white"
              aria-label="Toggle navigation"
            />
            <Text
              component={Link}
              to="/"
              fw={700}
              fz="xl"
              c="white"
              style={{ textDecoration: 'none', fontFamily: 'var(--mantine-font-family-headings)' }}
            >
              {BRAND}
            </Text>
            <Group gap={4} visibleFrom="sm" wrap="nowrap">
              {LINKS.map(({ to, label, icon: Icon, end }) => (
                <Button
                  key={to}
                  component={RouterNavLink}
                  to={to}
                  end={end}
                  variant="subtle"
                  color="white"
                  size="compact-md"
                  leftSection={<Icon />}
                  styles={{ root: { '&[aria-current="page"]': { background: 'rgba(255,255,255,0.22)' } } }}
                >
                  {label}
                </Button>
              ))}
            </Group>
          </Group>

          <Group gap="xs" wrap="nowrap">
            <ActionIcon
              variant="subtle"
              color="white"
              onClick={() => setColorScheme(scheme === 'dark' ? 'light' : 'dark')}
              aria-label="Toggle colour scheme"
            >
              {scheme === 'dark' ? <MdLightMode /> : <MdDarkMode />}
            </ActionIcon>
            <Button
              component="a"
              href="/cdn-cgi/access/logout"
              variant="subtle"
              color="white"
              size="compact-md"
              leftSection={<MdLogout />}
              visibleFrom="sm"
            >
              Log out
            </Button>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="md">
        {LINKS.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            component={RouterNavLink}
            to={to}
            end={end}
            label={label}
            leftSection={<Icon />}
            onClick={close}
          />
        ))}
        <NavLink component="a" href="/cdn-cgi/access/logout" label="Log out" leftSection={<MdLogout />} />
      </AppShell.Navbar>

      <AppShell.Main>
        <Container size="xl" py="md">
          <Outlet />
        </Container>
      </AppShell.Main>
    </AppShell>
  );
};

export default Layout;
```

- [ ] **Step 4: Convert `src/App.tsx` to a data router**

Replace the file with:

```tsx
import { ChakraProvider } from '@chakra-ui/react';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider, ScrollRestoration } from 'react-router-dom';
import Albums from './components/Albums';
import DailySuggestion from './components/DailySuggestion';
import Dashboard from './components/Dashboard';
import Layout from './components/Layout';
import PhotoDetail from './components/PhotoDetail';
import Search from './components/Search';
import { theme } from './theme';

const queryClient = new QueryClient();

const RootLayout = () => (
  <>
    <Layout />
    <ScrollRestoration />
  </>
);

const router = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
      { path: '/', element: <Dashboard /> },
      { path: '/albums', element: <Albums /> },
      { path: '/search', element: <Search /> },
      { path: '/photos/:id', element: <PhotoDetail /> },
      { path: '/daily', element: <DailySuggestion /> },
    ],
  },
]);

function App() {
  return (
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <Notifications />
      <ChakraProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ChakraProvider>
    </MantineProvider>
  );
}

export default App;
```

Chakra pages keep working because `ChakraProvider` still wraps the router. Their old grey page background (`bg="gray.50"`) is gone, which is intended.

- [ ] **Step 5: Delete `Navigation.tsx` and verify**

Run: `git rm src/components/Navigation.tsx && npm test && npm run lint && npm run build`
Expected: PASS, including the 4 new Layout tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add Mantine AppShell layout with responsive header and data router

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 4: Port PhotoMeta and DailySuggestion

**Files:**
- Modify: `src/components/PhotoMeta.tsx`, `src/components/DailySuggestion.tsx`, `src/components/__tests__/DailySuggestion.test.tsx`

**Interfaces:**
- Consumes: `renderWithProviders`, `notifications` from `@mantine/notifications`.
- Produces: `PhotoMeta({ photo, compact? })` (same props as before).

- [ ] **Step 1: Port the DailySuggestion test first**

In `src/components/__tests__/DailySuggestion.test.tsx`: delete the `ChakraProvider`, `MemoryRouter` and local `renderWithProviders` helper, import `renderWithProviders` from `../../test/renderWithProviders`, and render with `renderWithProviders(<DailySuggestion />)`. Keep every assertion. Toast text assertions ("Copied to clipboard", "Failed to copy") keep working because the helper mounts `<Notifications />`.

Run: `npx vitest run src/components/__tests__/DailySuggestion.test.tsx`
Expected: PASS against the still-Chakra component (Mantine provider is present at test root via the helper, Chakra components render unstyled, which is fine for assertions). If a Chakra component throws for lack of `ChakraProvider`, wrap the render in `<ChakraProvider>` inside the test until Step 3 lands.

- [ ] **Step 2: Rewrite `PhotoMeta.tsx`**

```tsx
import { Anchor, Stack, Text } from '@mantine/core';
import type { SerializedPhoto } from '../types/api';
import { exifSummary, formatPhotoDate, mapsUrl } from '../services/exif';

/** Capture date, location link and camera details; `compact` is the one-line listing form. */
const PhotoMeta = ({ photo, compact = false }: { photo: SerializedPhoto; compact?: boolean }) => {
  const date = formatPhotoDate(photo.dateTime);
  // Listings show only the camera body; the detail page has the full details.
  const camera = compact ? (photo.cameraModel ? [photo.cameraModel] : []) : exifSummary(photo);
  const location = mapsUrl(photo);

  if (!date && camera.length === 0 && !location) return null;

  return (
    <Stack gap={0} mb="xs">
      {(date || location) && (
        <Text size="xs" c="dimmed">
          {date}
          {date && location && ' · '}
          {location && (
            <Anchor href={location} target="_blank" rel="noopener noreferrer" size="xs">
              View location
            </Anchor>
          )}
        </Text>
      )}
      {camera.length > 0 && (
        <Text size="xs" c="dimmed">
          {camera.join(' · ')}
        </Text>
      )}
    </Stack>
  );
};

export default PhotoMeta;
```

- [ ] **Step 3: Rewrite `DailySuggestion.tsx`**

```tsx
import { Anchor, Badge, Button, Card, Group, Image, Skeleton, Stack, Text, Textarea, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { getOriginalUrl } from '../services/originals';
import PhotoMeta from './PhotoMeta';

const DailySuggestion = () => {
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
        notifications.show({ title: 'Copied to clipboard', message: '', color: 'green', autoClose: 2000 });
      },
      (err: Error) => {
        notifications.show({ title: 'Failed to copy', message: err.message, color: 'red', autoClose: 3000 });
      }
    );
  };

  const originalUrl = suggestion ? getOriginalUrl(suggestion.photo) : null;

  return (
    <Card withBorder maw={1100} mx="auto" w="100%">
      <Title order={3} mb="md">
        Today's Instagram Pick
      </Title>
      {isLoading ? (
        <Stack>
          <Skeleton height={400} />
          <Skeleton height={20} />
          <Skeleton height={100} />
          <Skeleton height={40} />
        </Stack>
      ) : error ? (
        <Text c="red">
          {error instanceof Error ? error.message : 'An error occurred while loading the suggestion'}
        </Text>
      ) : suggestion ? (
        <Stack>
          <Image
            src={workerApiClient.thumbnailUrl(suggestion.photo)}
            alt={suggestion.photo.description ?? suggestion.photo.filename ?? suggestion.photo.id}
            radius="md"
            fit="contain"
            mah={500}
          />
          <PhotoMeta photo={suggestion.photo} />

          <Text fw={700}>Why this photo?</Text>
          <Text>{suggestion.reason}</Text>

          <Text fw={700}>Suggested Caption</Text>
          <Textarea value={suggestion.suggestedCaption} readOnly rows={4} />

          <Text fw={700}>Suggested Hashtags</Text>
          <Group gap="xs">
            {suggestion.suggestedHashtags.map((tag) => (
              <Badge key={tag} variant="light">
                #{tag}
              </Badge>
            ))}
          </Group>

          <Button onClick={handleCopyToClipboard} w="fit-content">
            Copy to Clipboard
          </Button>

          {originalUrl && (
            <Anchor href={originalUrl} target="_blank" rel="noopener noreferrer">
              View Original
            </Anchor>
          )}
        </Stack>
      ) : (
        <Text>No suggestion available</Text>
      )}
    </Card>
  );
};

export default DailySuggestion;
```

- [ ] **Step 4: Verify**

Run: `npm test && npm run lint && npm run build`
Expected: PASS. (`Search.tsx` still imports `PhotoMeta` and keeps working.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Port PhotoMeta and DailySuggestion to Mantine

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Phase 2: Features

### Task 5: Worker, rich `/albums`

**Files:**
- Modify: `worker/src/routes/photos.ts`, `worker/test/photos.test.ts`, `test/functions/api.test.ts`

**Interfaces:**
- Produces: `GET /albums?limit&offset` returns `{ albums: Array<{ name: string; photoCount: number; coverPhotoId: string; coverThumbnailUrl: string | null; latestDate: string | null }>; total: number }`; `GET /albums?names=1` returns `{ albums: string[] }`.

- [ ] **Step 1: Replace the albums test and add new ones**

In `worker/test/photos.test.ts`, replace the `GET /albums returns distinct album names` test and add a new `describe` block after the existing one:

```ts
describe('GET /albums', () => {
  async function insert(
    id: string,
    hash: string,
    album: string | null,
    dateTime: string | null,
    lastIndexed = '2026-09-18T00:00:00.000Z'
  ) {
    await env.DB.prepare(
      `INSERT INTO photos (id, content_hash, source, filename, album, date_time, model_provider, model_name, last_indexed)
       VALUES (?,?,'local',?,?,?,'ollama','qwen3.5:27b-mlx',?)`
    )
      .bind(id, hash, `${id}.jpg`, album, dateTime, lastIndexed)
      .run();
  }

  async function get(query = '') {
    const response = await SELF.fetch(`https://example.com/albums${query}`, {
      headers: { Authorization: `Bearer ${env.READ_TOKEN}` },
    });
    return (await response.json()) as any;
  }

  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM photos').run();
  });

  it('returns rich albums with count, newest-photo cover and total', async () => {
    await insert('k-old', 'h-k-old', 'Kanha', '2026-01-01T00:00:00.000Z');
    await insert('k-new', 'h-k-new', 'Kanha', '2026-03-01T00:00:00.000Z');
    await insert('z-1', 'h-z-1', 'Kaziranga', '2026-02-01T00:00:00.000Z');
    await insert('loose', 'h-loose', null, '2026-04-01T00:00:00.000Z');

    const body = await get();
    expect(body.total).toBe(2);
    expect(body.albums).toEqual([
      {
        name: 'Kanha',
        photoCount: 2,
        coverPhotoId: 'k-new',
        coverThumbnailUrl: '/thumbnails/h-k-new',
        latestDate: '2026-03-01T00:00:00.000Z',
      },
      {
        name: 'Kaziranga',
        photoCount: 1,
        coverPhotoId: 'z-1',
        coverThumbnailUrl: '/thumbnails/h-z-1',
        latestDate: '2026-02-01T00:00:00.000Z',
      },
    ]);
  });

  it('paginates with limit and offset while total stays the album count', async () => {
    await insert('a', 'h-a', 'A', '2026-03-01T00:00:00.000Z');
    await insert('b', 'h-b', 'B', '2026-02-01T00:00:00.000Z');
    await insert('c', 'h-c', 'C', '2026-01-01T00:00:00.000Z');

    const page = await get('?limit=1&offset=1');
    expect(page.total).toBe(3);
    expect(page.albums.map((a: { name: string }) => a.name)).toEqual(['B']);
  });

  it('falls back to last_indexed for ordering when date_time is null and reports a null latestDate', async () => {
    await insert('n-1', 'h-n-1', 'Undated', null, '2026-09-01T00:00:00.000Z');
    await insert('d-1', 'h-d-1', 'Dated', '2026-01-01T00:00:00.000Z');

    const body = await get();
    expect(body.albums.map((a: { name: string }) => a.name)).toEqual(['Undated', 'Dated']);
    expect(body.albums[0].latestDate).toBeNull();
  });

  it('clamps limit to 48 and a negative offset to 0', async () => {
    await insert('a', 'h-a', 'A', '2026-03-01T00:00:00.000Z');
    const body = await get('?limit=9999&offset=-5');
    expect(body.albums).toHaveLength(1);
  });

  it('returns an empty page for an empty library', async () => {
    expect(await get()).toEqual({ albums: [], total: 0 });
  });

  it('names=1 returns the plain list of names for dropdowns', async () => {
    await insert('b', 'h-b', 'Beta', '2026-02-01T00:00:00.000Z');
    await insert('a', 'h-a', 'Alpha', '2026-03-01T00:00:00.000Z');
    expect(await get('?names=1')).toEqual({ albums: ['Alpha', 'Beta'] });
  });
});
```

Delete the old `it('GET /albums returns distinct album names', ...)` from the first `describe`, and change that describe's title to `'GET /photos/:id'`.

- [ ] **Step 2: Run, expect failure**

Run: `cd worker && npx vitest run test/photos.test.ts`
Expected: FAIL (old shape returned).

- [ ] **Step 3: Implement**

Replace `getAlbumsRoute` in `worker/src/routes/photos.ts`:

```ts
interface AlbumRow {
  name: string;
  photo_count: number;
  cover_photo_id: string;
  content_hash: string | null;
  latest_date: string | null;
}

export async function getAlbumsRoute(c: Context<{ Bindings: Env }>) {
  // Lightweight list for dropdowns.
  if (c.req.query('names') === '1') {
    const result = await c.env.DB.prepare(
      'SELECT DISTINCT album FROM photos WHERE album IS NOT NULL ORDER BY album'
    ).all<{ album: string }>();
    return c.json({ albums: result.results.map((r) => r.album) });
  }

  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 12, 1), 48);
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);

  // Cover is the newest photo in the album: date_time, else last_indexed, ties by id.
  const [rows, count] = await Promise.all([
    c.env.DB.prepare(
      `WITH ranked AS (
         SELECT album, id, content_hash, date_time,
                COALESCE(date_time, last_indexed) AS ts,
                ROW_NUMBER() OVER (
                  PARTITION BY album ORDER BY COALESCE(date_time, last_indexed) DESC, id
                ) AS rn,
                COUNT(*) OVER (PARTITION BY album) AS cnt
         FROM photos
         WHERE album IS NOT NULL
       )
       SELECT album AS name, cnt AS photo_count, id AS cover_photo_id,
              content_hash, date_time AS latest_date
       FROM ranked
       WHERE rn = 1
       ORDER BY ts DESC, album
       LIMIT ? OFFSET ?`
    )
      .bind(limit, offset)
      .all<AlbumRow>(),
    c.env.DB.prepare('SELECT COUNT(DISTINCT album) AS total FROM photos WHERE album IS NOT NULL').first<{
      total: number;
    }>(),
  ]);

  return c.json({
    albums: rows.results.map((r) => ({
      name: r.name,
      photoCount: r.photo_count,
      coverPhotoId: r.cover_photo_id,
      coverThumbnailUrl: r.content_hash ? `/thumbnails/${r.content_hash}` : null,
      latestDate: r.latest_date ?? null,
    })),
    total: count?.total ?? 0,
  });
}
```

- [ ] **Step 4: Run, expect pass**

Run: `cd worker && npm test`
Expected: PASS (all worker suites).

- [ ] **Step 5: Proxy passes the query string through**

In `test/functions/api.test.ts`, add `'/api/albums?limit=12&offset=0'` and `'/api/albums?names=1'` to the `it.each([...])` list that currently starts with `'/api/albums'` (line ~34). Run: `npx vitest run test/functions/api.test.ts`
Expected: PASS without changes to `functions/api/[[path]].ts` (the path regex matches the pathname only). If it fails because the stub asserts the upstream URL, update the stub assertion to include the query string.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Worker: rich paginated /albums with cover photos, names=1 for dropdowns

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 6: Worker, `sort=date` on `/search`

**Files:**
- Modify: `worker/src/routes/search.ts`, `worker/test/search.test.ts`

**Interfaces:**
- Produces: `GET /search?...&sort=date` orders by `date_time DESC` (nulls last), then `last_indexed DESC`. Omitted or any other value keeps the current ordering.

- [ ] **Step 1: Add the failing test**

Append inside the `describe('GET /search', ...)` block in `worker/test/search.test.ts`:

```ts
  it('sort=date orders by photo date newest first, nulls last', async () => {
    await env.DB.prepare('DELETE FROM photos').run();
    const insert = (id: string, date: string | null) =>
      env.DB.prepare(
        `INSERT INTO photos (id, content_hash, source, filename, album, date_time, model_provider, model_name, search_text, last_indexed)
         VALUES (?,?,'local',?,'Kanha',?,'ollama','qwen3.5:27b-mlx','',  '2026-09-18T00:00:00.000Z')`
      )
        .bind(id, `h-${id}`, `${id}.jpg`, date)
        .run();
    await insert('old', '2026-01-01T00:00:00.000Z');
    await insert('undated', null);
    await insert('new', '2026-05-01T00:00:00.000Z');

    const response = await SELF.fetch('https://example.com/search?album=Kanha&sort=date', {
      headers: { Authorization: `Bearer ${env.READ_TOKEN}` },
    });
    const body = (await response.json()) as any;
    expect(body.results.map((r: { id: string }) => r.id)).toEqual(['new', 'old', 'undated']);
  });
```

- [ ] **Step 2: Run, expect failure**

Run: `cd worker && npx vitest run test/search.test.ts`
Expected: FAIL (order is by `last_indexed`, ties arbitrary).

- [ ] **Step 3: Implement**

In `worker/src/routes/search.ts`, add `const sort = c.req.query('sort');` next to the other query reads, and change the `order` line to:

```ts
    // sort=date: newest photo first (album pages). Otherwise best text match first;
    // newest indexed first among equals and when there is no query.
    const order =
      sort === 'date'
        ? `ORDER BY photos.date_time DESC, last_indexed DESC`
        : match
          ? `ORDER BY bm25(photos_fts), last_indexed DESC`
          : `ORDER BY last_indexed DESC`;
```

- [ ] **Step 4: Run, expect pass**

Run: `cd worker && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Worker: sort=date option for album photo listings

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 7: API client, types, originals helper

**Files:**
- Modify: `src/types/api.ts`, `src/services/api/WorkerApiClient.ts`, `src/services/originals.ts`, `src/services/api/__tests__/WorkerApiClient.test.ts`, `src/services/__tests__/originals.test.ts`

**Interfaces:**
- Produces:
  - `AlbumSummary { name: string; photoCount: number; coverPhotoId: string; coverThumbnailUrl: string | null; latestDate: string | null }`
  - `AlbumsPageResponse { albums: AlbumSummary[]; total: number }`
  - `SearchParams.sort?: 'date'`
  - `workerApiClient.getAlbums(): Promise<string[]>` (names, now calls `/albums?names=1`)
  - `workerApiClient.getAlbumsPage(params?: { limit?: number; offset?: number }): Promise<AlbumsPageResponse>`
  - `getOriginalImageUrl(photo: SerializedPhoto): string | null` (local photos only)

- [ ] **Step 1: Write failing tests**

In `src/services/api/__tests__/WorkerApiClient.test.ts`, change the existing getAlbums URL expectation from `/albums` to `/albums?names=1` and add (adapting the file's existing fetch-stub pattern; shown here with a plain stub):

```ts
  it('getAlbumsPage requests limit and offset and returns the page', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ albums: [], total: 0 }), { status: 200 })
    );
    const client = new WorkerApiClient('/api', fetchFn);
    const page = await client.getAlbumsPage({ limit: 12, offset: 24 });
    expect(fetchFn).toHaveBeenCalledWith('/api/albums?limit=12&offset=24');
    expect(page).toEqual({ albums: [], total: 0 });
  });

  it('searchPage forwards sort=date', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [], total: 0 }), { status: 200 })
    );
    const client = new WorkerApiClient('/api', fetchFn);
    await client.searchPage({ album: 'Kanha', sort: 'date', limit: 12, offset: 0 });
    expect(fetchFn).toHaveBeenCalledWith('/api/search?album=Kanha&sort=date&limit=12&offset=0');
  });
```

In `src/services/__tests__/originals.test.ts` add:

```ts
import { getOriginalImageUrl } from '../originals';
import { makePhoto } from '../../test/fixtures';

describe('getOriginalImageUrl', () => {
  it('returns the proxied image URL for local photos', () => {
    expect(getOriginalImageUrl(makePhoto({ id: 'a b', source: 'local' }))).toBe('/api/originals/a%20b');
  });

  it('returns null for Drive photos, which only have a viewer page', () => {
    expect(getOriginalImageUrl(makePhoto({ source: 'google_drive', driveFileId: 'x' }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run src/services`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/types/api.ts`, add:

```ts
export interface AlbumSummary {
  name: string;
  photoCount: number;
  coverPhotoId: string;
  coverThumbnailUrl: string | null;
  /** Capture date of the cover (newest) photo; null when the photo has no date. */
  latestDate: string | null;
}

export interface AlbumsPageResponse {
  albums: AlbumSummary[];
  /** Total number of albums, ignoring limit/offset. */
  total: number;
}
```

`src/services/api/WorkerApiClient.ts`: import `AlbumsPageResponse`; add `sort?: 'date';` to `SearchParams`; in `searchPage` add `if (params.sort) query.set('sort', params.sort);` between `album` and `limit` (this order is what the test above asserts); replace `getAlbums` and add `getAlbumsPage`:

```ts
  /** Album names only, for dropdowns. */
  async getAlbums(): Promise<string[]> {
    const { albums } = await this.getJson<AlbumsResponse>('/albums?names=1');
    return albums;
  }

  async getAlbumsPage(params: { limit?: number; offset?: number } = {}): Promise<AlbumsPageResponse> {
    const query = new URLSearchParams();
    if (params.limit != null) query.set('limit', String(params.limit));
    if (params.offset != null) query.set('offset', String(params.offset));
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return this.getJson<AlbumsPageResponse>(`/albums${suffix}`);
  }
```

`src/services/originals.ts`, append:

```ts
/**
 * A URL that serves the original as an image, usable for prefetching and a
 * lightbox. Drive originals are viewer pages (HTML), so they have none.
 */
export function getOriginalImageUrl(photo: SerializedPhoto): string | null {
  return photo.source === 'local' ? `/api/originals/${encodeURIComponent(photo.id)}` : null;
}
```

- [ ] **Step 4: Verify and commit**

Run: `npm test && npm run lint && npm run build`
Expected: PASS (other tests that mock `getAlbums` still match its unchanged return type).

```bash
git add -A
git commit -m "Client: albums page API, sort option, original image URL helper

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 8: List params hook and pagination bar

**Files:**
- Create: `src/hooks/useListParams.ts`, `src/hooks/__tests__/useListParams.test.tsx`, `src/components/ListPagination.tsx`, `src/components/__tests__/ListPagination.test.tsx`

**Interfaces:**
- Produces:
  - `useListParams(defaultSize?: number, sizes?: readonly number[])` returns `{ params: URLSearchParams; page: number; size: number; offset: number; update(patch: Record<string, string | number | null | undefined>, opts?: { resetPage?: boolean; replace?: boolean }): void }`
  - `PAGE_SIZES = [10, 20, 50] as const`
  - `<ListPagination page size total sizes onPage onSize />` where `onPage(page: number, replace?: boolean)` and `onSize(size: number)`

- [ ] **Step 1: Write failing hook tests**

`src/hooks/__tests__/useListParams.test.tsx`:

```tsx
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { useListParams } from '../useListParams';

const wrapperAt = (url: string) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>;
  };

describe('useListParams', () => {
  it('defaults to page 1, size 10', () => {
    const { result } = renderHook(() => useListParams(), { wrapper: wrapperAt('/search') });
    expect(result.current).toMatchObject({ page: 1, size: 10, offset: 0 });
  });

  it('reads page and size and computes the offset', () => {
    const { result } = renderHook(() => useListParams(), { wrapper: wrapperAt('/search?page=3&size=20') });
    expect(result.current).toMatchObject({ page: 3, size: 20, offset: 40 });
  });

  it.each(['page=0', 'page=-2', 'page=abc', 'page='])('treats %s as page 1', (qs) => {
    const { result } = renderHook(() => useListParams(), { wrapper: wrapperAt(`/search?${qs}`) });
    expect(result.current.page).toBe(1);
  });

  it('falls back to the default size for sizes that are not offered', () => {
    const { result } = renderHook(() => useListParams(), { wrapper: wrapperAt('/search?size=7') });
    expect(result.current.size).toBe(10);
  });

  it('update() patches params, drops empties and defaults, and resets the page', () => {
    const { result } = renderHook(() => useListParams(), { wrapper: wrapperAt('/search?q=lion&page=4') });
    act(() => result.current.update({ q: 'leopard', album: '' }, { resetPage: true }));
    expect(result.current.params.get('q')).toBe('leopard');
    expect(result.current.params.has('album')).toBe(false);
    expect(result.current.params.has('page')).toBe(false);
  });

  it('omits size when it equals the default', () => {
    const { result } = renderHook(() => useListParams(), { wrapper: wrapperAt('/search?size=20') });
    act(() => result.current.update({ size: 10 }));
    expect(result.current.params.has('size')).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run src/hooks`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/hooks/useListParams.ts`**

```ts
import { useSearchParams } from 'react-router-dom';

export const PAGE_SIZES = [10, 20, 50] as const;

type Patch = Record<string, string | number | null | undefined>;

/**
 * Pagination state that lives in the URL, so every list page is deep-linkable
 * and back/forward restores it. Invalid or default values never reach the URL.
 */
export function useListParams(defaultSize = 10, sizes: readonly number[] = PAGE_SIZES) {
  const [params, setParams] = useSearchParams();

  const page = Math.max(1, Math.floor(Number(params.get('page'))) || 1);
  const requested = Number(params.get('size'));
  const size = sizes.includes(requested) ? requested : defaultSize;

  const update = (patch: Patch, opts: { resetPage?: boolean; replace?: boolean } = {}) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined || value === '') next.delete(key);
      else next.set(key, String(value));
    }
    if (opts.resetPage) next.delete('page');
    if (next.get('page') === '1') next.delete('page');
    if (Number(next.get('size')) === defaultSize) next.delete('size');
    setParams(next, { replace: opts.replace ?? false });
  };

  return { params, page, size, offset: (page - 1) * size, update };
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run src/hooks`
Expected: PASS.

- [ ] **Step 5: Write failing ListPagination tests**

`src/components/__tests__/ListPagination.test.tsx`:

```tsx
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/renderWithProviders';
import ListPagination from '../ListPagination';

const base = { page: 1, size: 10, total: 56, sizes: [10, 20, 50], onPage: vi.fn(), onSize: vi.fn() };

describe('ListPagination', () => {
  it('shows the visible range and total', () => {
    renderWithProviders(<ListPagination {...base} page={2} />);
    expect(screen.getByText('Showing 11-20 of 56')).toBeInTheDocument();
  });

  it('caps the range end at the total', () => {
    renderWithProviders(<ListPagination {...base} page={6} />);
    expect(screen.getByText('Showing 51-56 of 56')).toBeInTheDocument();
  });

  it('reports page changes', () => {
    const onPage = vi.fn();
    renderWithProviders(<ListPagination {...base} onPage={onPage} />);
    fireEvent.click(screen.getByRole('button', { name: '2' }));
    expect(onPage).toHaveBeenCalledWith(2);
  });

  it('renders nothing for an empty result', () => {
    const { container } = renderWithProviders(<ListPagination {...base} total={0} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('replaces the URL with the last page when page is out of range', () => {
    const onPage = vi.fn();
    renderWithProviders(<ListPagination {...base} page={999} onPage={onPage} />);
    expect(onPage).toHaveBeenCalledWith(6, true);
  });
});
```

- [ ] **Step 6: Run, expect failure, then implement `src/components/ListPagination.tsx`**

Run: `npx vitest run src/components/__tests__/ListPagination.test.tsx` → FAIL.

```tsx
import { Group, Pagination, Select, Text } from '@mantine/core';
import { useEffect } from 'react';

interface Props {
  page: number;
  size: number;
  total: number;
  sizes: readonly number[];
  onPage: (page: number, replace?: boolean) => void;
  onSize: (size: number) => void;
}

const ListPagination = ({ page, size, total, sizes, onPage, onSize }: Props) => {
  const pages = Math.max(1, Math.ceil(total / size));

  // A stale or hand-edited URL can point past the last page: land on the last one.
  useEffect(() => {
    if (total > 0 && page > pages) onPage(pages, true);
  }, [total, page, pages, onPage]);

  if (total === 0) return null;

  const from = (Math.min(page, pages) - 1) * size + 1;
  const to = Math.min(Math.min(page, pages) * size, total);

  return (
    <Group justify="space-between" gap="md">
      <Text size="sm" c="dimmed">
        Showing {from}-{to} of {total}
      </Text>
      <Pagination total={pages} value={Math.min(page, pages)} onChange={(p) => onPage(p)} />
      <Select
        aria-label="Results per page"
        data={sizes.map(String)}
        value={String(size)}
        onChange={(value) => value && onSize(Number(value))}
        allowDeselect={false}
        w={90}
      />
    </Group>
  );
};

export default ListPagination;
```

The effect lists `onPage` as a dependency; callers must pass a stable callback (`useCallback`) or the clamp could re-fire, which is harmless because it is idempotent once `page <= pages`.

- [ ] **Step 7: Verify and commit**

Run: `npm test && npm run lint && npm run build`
Expected: PASS.

```bash
git add -A
git commit -m "Add URL-backed list params hook and pagination bar

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 9: PhotoCard and PhotoGrid

**Files:**
- Create: `src/components/PhotoCard.tsx`, `src/components/PhotoGrid.tsx`, `src/components/__tests__/PhotoCard.test.tsx`

**Interfaces:**
- Consumes: `PhotoMeta`, `shortDescription`, `getOriginalUrl`, `workerApiClient.thumbnailUrl`.
- Produces: `PhotoCard({ photo: SerializedPhoto })`, `PhotoGrid({ photos: SerializedPhoto[] })`.

- [ ] **Step 1: Write failing tests** (these port the listing assertions from the old Search tests)

`src/components/__tests__/PhotoCard.test.tsx`:

```tsx
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makePhoto } from '../../test/fixtures';
import { renderWithProviders } from '../../test/renderWithProviders';
import PhotoCard from '../PhotoCard';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: {
    thumbnailUrl: vi.fn((p: { thumbnailUrl?: string }) => `https://example.workers.dev${p.thumbnailUrl}`),
  },
}));

vi.mock('../../services/originals', () => ({
  getOriginalUrl: vi.fn(() => '/api/originals/p1'),
}));

describe('PhotoCard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the thumbnail and description', () => {
    renderWithProviders(<PhotoCard photo={makePhoto()} />);
    expect(screen.getByText('A leopard in a tree.')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /leopard in a tree/i })).toHaveAttribute(
      'src',
      'https://example.workers.dev/thumbnails/h1'
    );
  });

  it('shows only the camera body in listings', () => {
    renderWithProviders(
      <PhotoCard photo={makePhoto({ cameraModel: 'NIKON Z 8', lensModel: 'VR 200-500mm f/5.6E', iso: 2500 })} />
    );
    expect(screen.getByText('NIKON Z 8')).toBeInTheDocument();
    expect(screen.queryByText(/200-500mm/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ISO 2500/)).not.toBeInTheDocument();
  });

  it('links to the detail page, trims long descriptions and caps tags', () => {
    const long = 'A leopard rests on a branch. ' + 'It watches the forest floor below with patient attention. '.repeat(6);
    renderWithProviders(
      <PhotoCard photo={makePhoto({ description: long, tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })} />
    );
    expect(screen.getByText('A leopard rests on a branch.')).toBeInTheDocument();
    expect(screen.queryByText(/patient attention/)).not.toBeInTheDocument();
    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(screen.queryByText('g')).not.toBeInTheDocument();
    const links = screen.getAllByRole('link').filter((l) => l.getAttribute('href') === '/photos/p1');
    expect(links.length).toBeGreaterThan(0);
  });

  it('shows a View Original link opening in a new tab', () => {
    renderWithProviders(<PhotoCard photo={makePhoto()} />);
    const link = screen.getByRole('link', { name: /view original/i });
    expect(link).toHaveAttribute('href', '/api/originals/p1');
    expect(link).toHaveAttribute('target', '_blank');
  });
});
```

- [ ] **Step 2: Run, expect failure; implement**

Run: `npx vitest run src/components/__tests__/PhotoCard.test.tsx` → FAIL.

`src/components/PhotoCard.tsx`:

```tsx
import { Anchor, Badge, Card, Group, Image, Stack, Text } from '@mantine/core';
import { Link } from 'react-router-dom';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { getOriginalUrl } from '../services/originals';
import { shortDescription } from '../services/text';
import type { SerializedPhoto } from '../types/api';
import PhotoMeta from './PhotoMeta';

const MAX_LISTING_TAGS = 5;

const PhotoCard = ({ photo }: { photo: SerializedPhoto }) => {
  const originalUrl = getOriginalUrl(photo);
  const alt = shortDescription(photo.description, 80) || photo.filename || photo.id;

  return (
    <Card withBorder padding={0} radius="md" component="article">
      <Card.Section component={Link} to={`/photos/${photo.id}`} style={{ display: 'block' }}>
        <Image
          src={workerApiClient.thumbnailUrl(photo)}
          alt={alt}
          fit="contain"
          h={240}
          bg="var(--mantine-color-default-hover)"
        />
      </Card.Section>

      <Stack gap="xs" p="md">
        <Anchor component={Link} to={`/photos/${photo.id}`} c="inherit" underline="never">
          <Text size="sm">{shortDescription(photo.description)}</Text>
        </Anchor>
        <PhotoMeta photo={photo} compact />
        <Group gap={6}>
          {photo.tags.slice(0, MAX_LISTING_TAGS).map((tag) => (
            <Badge key={tag} variant="light" size="sm">
              {tag}
            </Badge>
          ))}
          {photo.tags.length > MAX_LISTING_TAGS && (
            <Badge variant="outline" size="sm">
              +{photo.tags.length - MAX_LISTING_TAGS}
            </Badge>
          )}
        </Group>
        {originalUrl && (
          <Anchor href={originalUrl} target="_blank" rel="noopener noreferrer" size="sm">
            View Original
          </Anchor>
        )}
      </Stack>
    </Card>
  );
};

export default PhotoCard;
```

`src/components/PhotoGrid.tsx`:

```tsx
import { SimpleGrid } from '@mantine/core';
import type { SerializedPhoto } from '../types/api';
import PhotoCard from './PhotoCard';

const PhotoGrid = ({ photos }: { photos: SerializedPhoto[] }) => (
  <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
    {photos.map((photo) => (
      <PhotoCard key={photo.id} photo={photo} />
    ))}
  </SimpleGrid>
);

export default PhotoGrid;
```

- [ ] **Step 3: Verify and commit**

Run: `npm test && npm run lint && npm run build`
Expected: PASS.

```bash
git add -A
git commit -m "Add shared PhotoCard and PhotoGrid on Mantine

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 10: Search page (URL driven, paginated)

**Files:**
- Modify (full rewrite): `src/components/Search.tsx`, `src/components/__tests__/Search.test.tsx`

**Interfaces:**
- Consumes: `useListParams`, `ListPagination`, `PhotoGrid`, `workerApiClient.searchPage`, `workerApiClient.getAlbums`, `renderWithProviders`, `renderWithRouter`.
- Produces: default export `Search`. URL contract: `/search?q=&album=&page=&size=`.

- [ ] **Step 1: Rewrite the test file (failing)**

`src/components/__tests__/Search.test.tsx`:

```tsx
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { makePhoto } from '../../test/fixtures';
import { renderWithProviders, renderWithRouter } from '../../test/renderWithProviders';
import Search from '../Search';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: {
    searchPage: vi.fn(),
    getAlbums: vi.fn(),
    thumbnailUrl: vi.fn((p: { thumbnailUrl?: string }) => `/api${p.thumbnailUrl}`),
  },
}));

vi.mock('../../services/originals', () => ({ getOriginalUrl: vi.fn(() => null) }));

const page = (n: number) =>
  Array.from({ length: n }, (_, i) => makePhoto({ id: `p${i}`, description: `Photo number ${i}.` }));

describe('Search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workerApiClient.getAlbums).mockResolvedValue(['Kanha', 'Kaziranga']);
    vi.mocked(workerApiClient.searchPage).mockResolvedValue({ results: page(10), total: 56 });
  });

  it('runs from the URL on load and fills the form from it', async () => {
    renderWithProviders(<Search />, { route: '/search?q=big+cat&album=Kanha&page=2&size=20' });

    await waitFor(() =>
      expect(workerApiClient.searchPage).toHaveBeenCalledWith({
        q: 'big cat',
        album: 'Kanha',
        limit: 20,
        offset: 20,
      })
    );
    expect(screen.getByPlaceholderText('Search photos...')).toHaveValue('big cat');
    expect(await screen.findByText('Photo number 0.')).toBeInTheDocument();
    expect(screen.getByText('Showing 21-30 of 56')).toBeInTheDocument();
  });

  it('lists everything newest first when there are no params', async () => {
    renderWithProviders(<Search />, { route: '/search' });
    await waitFor(() =>
      expect(workerApiClient.searchPage).toHaveBeenCalledWith({ q: '', album: '', limit: 10, offset: 0 })
    );
  });

  it('treats a whitespace-only query as empty', async () => {
    renderWithProviders(<Search />, { route: '/search?q=%20%20' });
    await waitFor(() =>
      expect(workerApiClient.searchPage).toHaveBeenCalledWith({ q: '', album: '', limit: 10, offset: 0 })
    );
  });

  it('submitting writes q to the URL and resets to page 1', async () => {
    const { router } = renderWithRouter([{ path: '/search', element: <Search /> }], ['/search?q=lion&page=3']);

    const input = await screen.findByPlaceholderText('Search photos...');
    fireEvent.change(input, { target: { value: 'leopard' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(router.state.location.search).toBe('?q=leopard'));
  });

  it('back navigation restores the previous query in the form', async () => {
    const { router } = renderWithRouter([{ path: '/search', element: <Search /> }], ['/search?q=lion']);

    const input = await screen.findByPlaceholderText('Search photos...');
    fireEvent.change(input, { target: { value: 'leopard' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(router.state.location.search).toBe('?q=leopard'));

    await router.navigate(-1);
    await waitFor(() => expect(screen.getByPlaceholderText('Search photos...')).toHaveValue('lion'));
  });

  it('paging updates the URL', async () => {
    const { router } = renderWithRouter([{ path: '/search', element: <Search /> }], ['/search?q=lion']);
    fireEvent.click(await screen.findByRole('button', { name: '2' }));
    await waitFor(() => expect(router.state.location.search).toBe('?q=lion&page=2'));
  });

  it('shows an empty state when nothing matches', async () => {
    vi.mocked(workerApiClient.searchPage).mockResolvedValue({ results: [], total: 0 });
    renderWithProviders(<Search />, { route: '/search?q=dragon' });
    expect(await screen.findByText(/no photos match/i)).toBeInTheDocument();
  });

  it('shows the error message when the search fails', async () => {
    vi.mocked(workerApiClient.searchPage).mockRejectedValue(new Error('Request to /search failed: 500'));
    renderWithProviders(<Search />, { route: '/search?q=lion' });
    expect(await screen.findByText('Request to /search failed: 500')).toBeInTheDocument();
  });
});
```

Run: `npx vitest run src/components/__tests__/Search.test.tsx`
Expected: FAIL.

- [ ] **Step 2: Rewrite `src/components/Search.tsx`**

```tsx
import { Button, Card, Group, Loader, Select, Stack, Text, TextInput } from '@mantine/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { MdSearch } from 'react-icons/md';
import { useListParams, PAGE_SIZES } from '../hooks/useListParams';
import { workerApiClient } from '../services/api/WorkerApiClient';
import ListPagination from './ListPagination';
import PhotoGrid from './PhotoGrid';

const Search = () => {
  const { params, page, size, offset, update } = useListParams();
  const q = (params.get('q') ?? '').trim();
  const album = params.get('album') ?? '';
  const [text, setText] = useState(params.get('q') ?? '');

  // Keep the box in step with the URL (back/forward, deep links).
  useEffect(() => {
    setText(params.get('q') ?? '');
  }, [params]);

  const { data: albums = [] } = useQuery({
    queryKey: ['album-names'],
    queryFn: () => workerApiClient.getAlbums(),
  });

  const { data, isFetching, error } = useQuery({
    queryKey: ['search', q, album, page, size],
    queryFn: () => workerApiClient.searchPage({ q, album, limit: size, offset }),
    placeholderData: keepPreviousData,
  });

  const submit = () => update({ q: text.trim() }, { resetPage: true });
  const onPage = useCallback(
    (p: number, replace?: boolean) => update({ page: p }, { replace }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params]
  );

  return (
    <Stack gap="lg">
      <Card withBorder>
        <Group align="flex-end" gap="md" grow preventGrowOverflow={false}>
          <Select
            label="Album"
            aria-label="Select photo album"
            placeholder="All albums"
            data={albums}
            value={album || null}
            onChange={(value) => update({ album: value }, { resetPage: true })}
            clearable
            searchable
          />
          <TextInput
            label="Search"
            placeholder="Search photos..."
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
          />
          <Button
            onClick={submit}
            leftSection={isFetching ? <Loader size="xs" color="white" /> : <MdSearch />}
            style={{ flexGrow: 0 }}
          >
            Search
          </Button>
        </Group>
      </Card>

      {error && <Text c="red">{error instanceof Error ? error.message : 'An error occurred'}</Text>}

      {data && data.results.length === 0 && <Text c="dimmed">No photos match your search.</Text>}

      {data && data.results.length > 0 && <PhotoGrid photos={data.results} />}

      {data && (
        <ListPagination
          page={page}
          size={size}
          total={data.total}
          sizes={PAGE_SIZES}
          onPage={onPage}
          onSize={(s) => update({ size: s }, { resetPage: true })}
        />
      )}
    </Stack>
  );
};

export default Search;
```

- [ ] **Step 3: Verify**

Run: `npm test && npm run lint && npm run build`
Expected: PASS. If the ESLint disable comment is flagged as unnecessary, delete it. If `onPage` re-creating on every `params` change causes the clamp effect to loop in a test, confirm the clamp only fires while `page > pages`; it must not.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Search: URL-driven state and server-side pagination on Mantine

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 11: Albums page, album photos page, routes

**Files:**
- Create: `src/components/AlbumCard.tsx`, `src/components/AlbumPhotos.tsx`, `src/components/__tests__/AlbumPhotos.test.tsx`
- Modify (rewrite): `src/components/Albums.tsx`, `src/components/__tests__/Albums.test.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `useListParams(12, [12, 24, 48])`, `ListPagination`, `PhotoGrid`, `workerApiClient.getAlbumsPage`, `workerApiClient.searchPage({ album, sort: 'date' })`, `formatPhotoDate`.
- Produces: routes `/albums` and `/albums/:name`; `AlbumCard({ album: AlbumSummary })` linking to `/albums/${encodeURIComponent(album.name)}`.

- [ ] **Step 1: Write failing tests**

`src/components/__tests__/Albums.test.tsx` (replace the file):

```tsx
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { renderWithProviders, renderWithRouter } from '../../test/renderWithProviders';
import Albums from '../Albums';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: {
    getAlbumsPage: vi.fn(),
    thumbnailUrl: vi.fn((p: { thumbnailUrl?: string }) => (p.thumbnailUrl ? `/api${p.thumbnailUrl}` : '')),
  },
}));

const album = (name: string, over = {}) => ({
  name,
  photoCount: 3,
  coverPhotoId: 'c1',
  coverThumbnailUrl: '/thumbnails/h1',
  latestDate: '2026-03-01T10:00:00.000Z',
  ...over,
});

describe('Albums', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workerApiClient.getAlbumsPage).mockResolvedValue({
      albums: [album('Kanha 2026'), album('A/B ? #1 & Ünï', { coverThumbnailUrl: null, latestDate: null })],
      total: 30,
    });
  });

  it('requests the first page of 12 and shows cover, name and count', async () => {
    renderWithProviders(<Albums />, { route: '/albums' });
    expect(await screen.findByText('Kanha 2026')).toBeInTheDocument();
    expect(workerApiClient.getAlbumsPage).toHaveBeenCalledWith({ limit: 12, offset: 0 });
    expect(screen.getAllByText('3 photos').length).toBeGreaterThan(0);
    expect(screen.getByRole('img', { name: /kanha 2026/i })).toHaveAttribute('src', '/api/thumbnails/h1');
    expect(screen.getByText('Showing 1-12 of 30')).toBeInTheDocument();
  });

  it('links each album to its own page with the name encoded', async () => {
    renderWithProviders(<Albums />, { route: '/albums' });
    const link = await screen.findByRole('link', { name: /kanha 2026/i });
    expect(link).toHaveAttribute('href', '/albums/Kanha%202026');
    const odd = screen.getByRole('link', { name: /A\/B \? #1 & Ünï/ });
    expect(odd).toHaveAttribute('href', `/albums/${encodeURIComponent('A/B ? #1 & Ünï')}`);
  });

  it('renders an album with no cover and no date without crashing', async () => {
    renderWithProviders(<Albums />, { route: '/albums' });
    expect(await screen.findByText('A/B ? #1 & Ünï')).toBeInTheDocument();
  });

  it('pages through the URL', async () => {
    const { router } = renderWithRouter([{ path: '/albums', element: <Albums /> }], ['/albums']);
    fireEvent.click(await screen.findByRole('button', { name: '2' }));
    await waitFor(() => expect(router.state.location.search).toBe('?page=2'));
    await waitFor(() =>
      expect(workerApiClient.getAlbumsPage).toHaveBeenLastCalledWith({ limit: 12, offset: 12 })
    );
  });

  it('shows an empty state for an empty library', async () => {
    vi.mocked(workerApiClient.getAlbumsPage).mockResolvedValue({ albums: [], total: 0 });
    renderWithProviders(<Albums />, { route: '/albums' });
    expect(await screen.findByText(/no albums yet/i)).toBeInTheDocument();
  });
});
```

`src/components/__tests__/AlbumPhotos.test.tsx`:

```tsx
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { makePhoto } from '../../test/fixtures';
import { renderWithProviders } from '../../test/renderWithProviders';
import AlbumPhotos from '../AlbumPhotos';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: {
    searchPage: vi.fn(),
    thumbnailUrl: vi.fn((p: { thumbnailUrl?: string }) => `/api${p.thumbnailUrl}`),
  },
}));
vi.mock('../../services/originals', () => ({ getOriginalUrl: vi.fn(() => null) }));

describe('AlbumPhotos', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workerApiClient.searchPage).mockResolvedValue({ results: [makePhoto()], total: 1 });
  });

  it('lists the album photos by date using the decoded name from the URL', async () => {
    renderWithProviders(<AlbumPhotos />, {
      route: `/albums/${encodeURIComponent('A/B #1')}`,
      path: '/albums/:name',
    });

    expect(await screen.findByRole('heading', { name: 'A/B #1' })).toBeInTheDocument();
    await waitFor(() =>
      expect(workerApiClient.searchPage).toHaveBeenCalledWith({
        album: 'A/B #1',
        sort: 'date',
        limit: 12,
        offset: 0,
      })
    );
    expect(await screen.findByText('A leopard in a tree.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /all albums/i })).toHaveAttribute('href', '/albums');
  });
});
```

Run: `npx vitest run src/components/__tests__/Albums.test.tsx src/components/__tests__/AlbumPhotos.test.tsx`
Expected: FAIL.

- [ ] **Step 2: Implement**

`src/components/AlbumCard.tsx`:

```tsx
import { Box, Card, Center, Image, Stack, Text } from '@mantine/core';
import { MdPhoto } from 'react-icons/md';
import { Link } from 'react-router-dom';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { formatPhotoDate } from '../services/exif';
import type { AlbumSummary } from '../types/api';

const AlbumCard = ({ album }: { album: AlbumSummary }) => {
  const date = formatPhotoDate(album.latestDate);
  const cover = album.coverThumbnailUrl
    ? workerApiClient.thumbnailUrl({ thumbnailUrl: album.coverThumbnailUrl })
    : '';

  return (
    <Card
      withBorder
      padding={0}
      radius="md"
      component={Link}
      to={`/albums/${encodeURIComponent(album.name)}`}
      style={{ textDecoration: 'none', color: 'inherit' }}
      aria-label={album.name}
    >
      <Card.Section>
        {cover ? (
          <Image src={cover} alt={album.name} h={180} fit="cover" />
        ) : (
          <Center h={180} bg="var(--mantine-color-default-hover)">
            <Box c="dimmed" fz={40} lh={1}>
              <MdPhoto aria-hidden />
            </Box>
          </Center>
        )}
      </Card.Section>
      <Stack gap={2} p="md">
        <Text fw={600} lineClamp={1}>
          {album.name}
        </Text>
        <Text size="sm" c="dimmed">
          {album.photoCount} {album.photoCount === 1 ? 'photo' : 'photos'}
          {date && ` · ${date}`}
        </Text>
      </Stack>
    </Card>
  );
};

export default AlbumCard;
```

`src/components/Albums.tsx`:

```tsx
import { SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useListParams } from '../hooks/useListParams';
import { workerApiClient } from '../services/api/WorkerApiClient';
import AlbumCard from './AlbumCard';
import ListPagination from './ListPagination';

const ALBUM_PAGE_SIZES = [12, 24, 48] as const;

const Albums = () => {
  const { page, size, offset, update } = useListParams(12, ALBUM_PAGE_SIZES);

  const { data, error } = useQuery({
    queryKey: ['albums-page', page, size],
    queryFn: () => workerApiClient.getAlbumsPage({ limit: size, offset }),
    placeholderData: keepPreviousData,
  });

  const onPage = useCallback(
    (p: number, replace?: boolean) => update({ page: p }, { replace }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [page, size]
  );

  return (
    <Stack gap="lg">
      <Title order={2}>Albums</Title>

      {error && <Text c="red">{error instanceof Error ? error.message : 'An error occurred'}</Text>}
      {data && data.albums.length === 0 && <Text c="dimmed">No albums yet.</Text>}

      {data && data.albums.length > 0 && (
        <SimpleGrid cols={{ base: 1, xs: 2, md: 3, lg: 4 }} spacing="md">
          {data.albums.map((album) => (
            <AlbumCard key={album.name} album={album} />
          ))}
        </SimpleGrid>
      )}

      {data && (
        <ListPagination
          page={page}
          size={size}
          total={data.total}
          sizes={ALBUM_PAGE_SIZES}
          onPage={onPage}
          onSize={(s) => update({ size: s }, { resetPage: true })}
        />
      )}
    </Stack>
  );
};

export default Albums;
```

`src/components/AlbumPhotos.tsx`:

```tsx
import { Anchor, Group, Stack, Text, Title } from '@mantine/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useListParams } from '../hooks/useListParams';
import { workerApiClient } from '../services/api/WorkerApiClient';
import ListPagination from './ListPagination';
import PhotoGrid from './PhotoGrid';

const ALBUM_PHOTO_SIZES = [12, 24, 48] as const;

const AlbumPhotos = () => {
  const { name = '' } = useParams();
  const { page, size, offset, update } = useListParams(12, ALBUM_PHOTO_SIZES);

  const { data, error } = useQuery({
    queryKey: ['album-photos', name, page, size],
    queryFn: () => workerApiClient.searchPage({ album: name, sort: 'date', limit: size, offset }),
    enabled: name !== '',
    placeholderData: keepPreviousData,
  });

  const onPage = useCallback(
    (p: number, replace?: boolean) => update({ page: p }, { replace }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [page, size]
  );

  return (
    <Stack gap="lg">
      <Anchor component={Link} to="/albums" size="sm">
        ← All albums
      </Anchor>
      <Group justify="space-between" align="baseline">
        <Title order={2}>{name}</Title>
        {data && (
          <Text c="dimmed">
            {data.total} {data.total === 1 ? 'photo' : 'photos'}
          </Text>
        )}
      </Group>

      {error && <Text c="red">{error instanceof Error ? error.message : 'An error occurred'}</Text>}
      {data && data.results.length === 0 && <Text c="dimmed">This album has no photos.</Text>}
      {data && data.results.length > 0 && <PhotoGrid photos={data.results} />}

      {data && (
        <ListPagination
          page={page}
          size={size}
          total={data.total}
          sizes={ALBUM_PHOTO_SIZES}
          onPage={onPage}
          onSize={(s) => update({ size: s }, { resetPage: true })}
        />
      )}
    </Stack>
  );
};

export default AlbumPhotos;
```

In `src/App.tsx` add `import AlbumPhotos from './components/AlbumPhotos';` and the route `{ path: '/albums/:name', element: <AlbumPhotos /> }` directly after `/albums`.

- [ ] **Step 3: Verify and commit**

Run: `npm test && npm run lint && npm run build`
Expected: PASS.

```bash
git add -A
git commit -m "Albums: paginated cover grid and a separate album photos page

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 12: Dashboard on Mantine

**Files:**
- Modify (rewrite): `src/components/Dashboard.tsx`, `src/components/__tests__/Dashboard.test.tsx`

**Interfaces:**
- Consumes: `workerApiClient.getAlbumsPage({ limit: 1 })` for the album count, `searchPage({ limit: 12 })` for recents, `BRAND`.

- [ ] **Step 1: Port the Dashboard test (failing first)**

Open `src/components/__tests__/Dashboard.test.tsx`. Replace its providers with `renderWithProviders`. In the `WorkerApiClient` mock, replace `getAlbums` with `getAlbumsPage` returning `{ albums: [], total: <the count the test asserts> }` (keep the same numbers the existing assertions expect). Add these tests:

```tsx
  it('titles the card PixdeX', async () => {
    renderWithProviders(<Dashboard />);
    expect(await screen.findByRole('heading', { name: 'PixdeX' })).toBeInTheDocument();
  });

  it('shows zero counts for an empty library', async () => {
    vi.mocked(workerApiClient.getAlbumsPage).mockResolvedValue({ albums: [], total: 0 });
    vi.mocked(workerApiClient.searchPage).mockResolvedValue({ results: [], total: 0 });
    renderWithProviders(<Dashboard />);
    expect(await screen.findAllByText('0')).toHaveLength(2);
  });
```

Run: `npx vitest run src/components/__tests__/Dashboard.test.tsx`
Expected: FAIL.

- [ ] **Step 2: Rewrite `src/components/Dashboard.tsx`**

```tsx
import { Anchor, Card, Image, SimpleGrid, Stack, Text, Title, UnstyledButton } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { shortDescription } from '../services/text';
import { BRAND } from '../theme';

const RECENT_COUNT = 12;

const Stat = ({ label, value, to }: { label: string; value: number; to: string }) => (
  <UnstyledButton component={Link} to={to}>
    <Text size="sm" c="dimmed">
      {label}
    </Text>
    <Text fz={32} fw={700} lh={1.1}>
      {value}
    </Text>
  </UnstyledButton>
);

const Dashboard = () => {
  const { data: albums } = useQuery({
    queryKey: ['albums-page', 1, 1],
    queryFn: () => workerApiClient.getAlbumsPage({ limit: 1 }),
  });

  const { data: recent } = useQuery({
    queryKey: ['recent-photos'],
    queryFn: () => workerApiClient.searchPage({ limit: RECENT_COUNT }),
  });

  return (
    <Stack gap="lg">
      <Card withBorder>
        <Title order={3} mb="md">
          {BRAND}
        </Title>
        <SimpleGrid cols={2}>
          <Stat label="Photos" value={recent?.total ?? 0} to="/search" />
          <Stat label="Albums" value={albums?.total ?? 0} to="/albums" />
        </SimpleGrid>
      </Card>

      {recent && recent.results.length > 0 && (
        <Card withBorder>
          <Title order={4} mb="md">
            Recently indexed
          </Title>
          <SimpleGrid cols={{ base: 2, md: 4, lg: 6 }} spacing="sm">
            {recent.results.map((photo) => (
              <Anchor key={photo.id} component={Link} to={`/photos/${photo.id}`} underline="never" c="inherit">
                <Image
                  src={workerApiClient.thumbnailUrl(photo)}
                  alt={shortDescription(photo.description, 80) || photo.filename || 'Photo'}
                  radius="md"
                  fit="contain"
                  h={120}
                  bg="var(--mantine-color-default-hover)"
                />
                {photo.album && (
                  <Text size="xs" lineClamp={1} mt={4}>
                    {photo.album}
                  </Text>
                )}
              </Anchor>
            ))}
          </SimpleGrid>
        </Card>
      )}

      <SimpleGrid cols={{ base: 1, md: 3 }}>
        {[
          { to: '/search', label: 'Search' },
          { to: '/albums', label: 'Albums' },
          { to: '/daily', label: 'Daily Pick' },
        ].map(({ to, label }) => (
          <Card key={to} withBorder component={Link} to={to} style={{ textDecoration: 'none', color: 'inherit' }}>
            {label}
          </Card>
        ))}
      </SimpleGrid>
    </Stack>
  );
};

export default Dashboard;
```

- [ ] **Step 3: Verify and commit**

Run: `npm test && npm run lint && npm run build`
Expected: PASS.

```bash
git add -A
git commit -m "Dashboard on Mantine with PixdeX title and real album count

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 13: Photo detail, prefetch and lightbox

**Files:**
- Create: `src/hooks/usePrefetchImage.ts`, `src/hooks/__tests__/usePrefetchImage.test.ts`, `src/components/Lightbox.tsx`
- Modify (rewrite): `src/components/PhotoDetail.tsx`, `src/components/__tests__/PhotoDetail.test.tsx`

**Interfaces:**
- Consumes: `getOriginalImageUrl`, `getOriginalUrl`, `renderWithRouter`, `makePhoto`.
- Produces:
  - `usePrefetchImage(url: string | null): 'idle' | 'loading' | 'ready' | 'error'`
  - `<Lightbox opened onClose thumbnailSrc originalSrc originalStatus alt fallbackHref />`
  - URL contract: `/photos/:id?lightbox=1`; opening pushes an entry with `state.lightbox = true`, closing goes back when that entry was pushed, otherwise replaces.

- [ ] **Step 1: Write failing hook test**

`src/hooks/__tests__/usePrefetchImage.test.ts`:

```ts
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePrefetchImage } from '../usePrefetchImage';

class FakeImage {
  static instances: FakeImage[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';
  constructor() {
    FakeImage.instances.push(this);
  }
}

describe('usePrefetchImage', () => {
  beforeEach(() => {
    FakeImage.instances = [];
    vi.stubGlobal('Image', FakeImage);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is idle and loads nothing without a URL', () => {
    const { result } = renderHook(() => usePrefetchImage(null));
    expect(result.current).toBe('idle');
    expect(FakeImage.instances).toHaveLength(0);
  });

  it('goes loading then ready', () => {
    const { result } = renderHook(() => usePrefetchImage('/api/originals/p1'));
    expect(result.current).toBe('loading');
    expect(FakeImage.instances[0].src).toBe('/api/originals/p1');
    act(() => FakeImage.instances[0].onload?.());
    expect(result.current).toBe('ready');
  });

  it('reports error when the original cannot load', () => {
    const { result } = renderHook(() => usePrefetchImage('/api/originals/p1'));
    act(() => FakeImage.instances[0].onerror?.());
    expect(result.current).toBe('error');
  });
});
```

Run: `npx vitest run src/hooks/__tests__/usePrefetchImage.test.ts` → FAIL.

- [ ] **Step 2: Implement the hook and the Lightbox**

`src/hooks/usePrefetchImage.ts`:

```ts
import { useEffect, useState } from 'react';

export type PrefetchStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Preload an image into the browser cache and report how it went. */
export function usePrefetchImage(url: string | null): PrefetchStatus {
  const [status, setStatus] = useState<PrefetchStatus>(url ? 'loading' : 'idle');

  useEffect(() => {
    if (!url) {
      setStatus('idle');
      return;
    }
    let cancelled = false;
    setStatus('loading');
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setStatus('ready');
    };
    img.onerror = () => {
      if (!cancelled) setStatus('error');
    };
    img.src = url;
    return () => {
      cancelled = true;
      img.onload = null;
      img.onerror = null;
    };
  }, [url]);

  return status;
}
```

`src/components/Lightbox.tsx`:

```tsx
import { Anchor, Center, Image, Loader, Modal, Stack, Text } from '@mantine/core';
import type { PrefetchStatus } from '../hooks/usePrefetchImage';

interface Props {
  opened: boolean;
  onClose: () => void;
  thumbnailSrc: string;
  /** Image URL of the original, or null when it cannot be shown inline (Drive). */
  originalSrc: string | null;
  originalStatus: PrefetchStatus;
  alt: string;
  /** Where the full original can be opened when it cannot be shown inline. */
  fallbackHref: string | null;
}

const Lightbox = ({ opened, onClose, thumbnailSrc, originalSrc, originalStatus, alt, fallbackHref }: Props) => {
  const showOriginal = originalSrc !== null && originalStatus === 'ready';
  const unavailable = originalSrc === null || originalStatus === 'error';

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      fullScreen
      title={alt}
      styles={{ content: { background: '#000' }, header: { background: '#000' }, title: { color: '#fff' } }}
    >
      <Stack align="center" gap="sm">
        <Image
          src={showOriginal ? originalSrc : thumbnailSrc}
          alt={alt}
          fit="contain"
          mah="calc(100vh - 140px)"
          maw="100%"
        />
        {originalSrc !== null && originalStatus === 'loading' && (
          <Center>
            <Loader size="sm" color="white" />
          </Center>
        )}
        {unavailable && (
          <Text c="gray.4" size="sm">
            {originalStatus === 'error'
              ? 'The original is unavailable right now (the machine hosting it may be offline).'
              : 'The original cannot be shown here.'}{' '}
            {fallbackHref && (
              <Anchor href={fallbackHref} target="_blank" rel="noopener noreferrer" c="aurora.3">
                Open original
              </Anchor>
            )}
          </Text>
        )}
      </Stack>
    </Modal>
  );
};

export default Lightbox;
```

- [ ] **Step 3: Rewrite the PhotoDetail test (failing)**

`src/components/__tests__/PhotoDetail.test.tsx` (replace the file; keep any additional field assertions from the old file that this one does not cover, ported to the same helpers):

```tsx
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workerApiClient } from '../../services/api/WorkerApiClient';
import { makePhoto } from '../../test/fixtures';
import { renderWithRouter } from '../../test/renderWithProviders';
import PhotoDetail from '../PhotoDetail';

vi.mock('../../services/api/WorkerApiClient', () => ({
  workerApiClient: { getPhoto: vi.fn(), thumbnailUrl: vi.fn(() => '/api/thumbnails/h1') },
}));

const originals = vi.hoisted(() => ({
  getOriginalUrl: vi.fn(),
  getOriginalImageUrl: vi.fn(),
}));
vi.mock('../../services/originals', () => originals);

class FakeImage {
  static instances: FakeImage[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';
  constructor() {
    FakeImage.instances.push(this);
  }
}

const routes = [
  { path: '/search', element: <p>search page</p> },
  { path: '/photos/:id', element: <PhotoDetail /> },
];

describe('PhotoDetail', () => {
  beforeEach(() => {
    FakeImage.instances = [];
    vi.stubGlobal('Image', FakeImage);
    originals.getOriginalUrl.mockReturnValue('/api/originals/p1');
    originals.getOriginalImageUrl.mockReturnValue('/api/originals/p1');
    vi.mocked(workerApiClient.getPhoto).mockResolvedValue(
      makePhoto({
        filename: 'DSC_8707-2.jpg',
        album: 'Kanha 2026',
        cameraModel: 'NIKON Z 8',
        lensModel: 'VR 200-500mm f/5.6E',
        iso: 2500,
      })
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows the photo details and links the album to its album page', async () => {
    renderWithRouter(routes, ['/photos/p1']);
    expect(await screen.findByRole('heading', { name: 'DSC_8707-2.jpg' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Kanha 2026' })).toHaveAttribute('href', '/albums/Kanha%202026');
    expect(screen.getByText('NIKON Z 8')).toBeInTheDocument();
  });

  it('prefetches the original on load', async () => {
    renderWithRouter(routes, ['/photos/p1']);
    await screen.findByRole('heading', { name: 'DSC_8707-2.jpg' });
    expect(FakeImage.instances.map((i) => i.src)).toContain('/api/originals/p1');
  });

  it('opens the lightbox on click and deep links it with ?lightbox=1', async () => {
    const { router } = renderWithRouter(routes, ['/photos/p1']);
    fireEvent.click(await screen.findByRole('button', { name: /open full-size photo/i }));
    await waitFor(() => expect(router.state.location.search).toBe('?lightbox=1'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('opens straight into the lightbox from a deep link', async () => {
    renderWithRouter(routes, ['/photos/p1?lightbox=1']);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('falls back to the thumbnail and an Open original link when the original fails', async () => {
    renderWithRouter(routes, ['/photos/p1?lightbox=1']);
    await screen.findByRole('dialog');
    FakeImage.instances.forEach((i) => i.onerror?.());
    expect(await screen.findByText(/original is unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open original' })).toHaveAttribute('href', '/api/originals/p1');
  });

  it('does not prefetch for Drive photos and the lightbox still opens safely', async () => {
    originals.getOriginalImageUrl.mockReturnValue(null);
    originals.getOriginalUrl.mockReturnValue('https://drive.google.com/file/d/x/view');
    vi.mocked(workerApiClient.getPhoto).mockResolvedValue(
      makePhoto({ filename: 'drive.jpg', source: 'google_drive', driveFileId: 'x' })
    );
    renderWithRouter(routes, ['/photos/p1?lightbox=1']);
    await screen.findByRole('dialog');
    expect(FakeImage.instances).toHaveLength(0);
    expect(screen.getByRole('link', { name: 'Open original' })).toHaveAttribute(
      'href',
      'https://drive.google.com/file/d/x/view'
    );
  });

  it('closing a lightbox that was opened by clicking goes back in history', async () => {
    const { router } = renderWithRouter(routes, ['/photos/p1']);
    fireEvent.click(await screen.findByRole('button', { name: /open full-size photo/i }));
    await screen.findByRole('dialog');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });

  it('back link falls back to the album when there is no history', async () => {
    renderWithRouter(routes, ['/photos/p1']);
    const back = await screen.findByRole('link', { name: /back to album/i });
    expect(back).toHaveAttribute('href', '/albums/Kanha%202026');
  });

  it('shows an error and a way back when the photo is missing', async () => {
    vi.mocked(workerApiClient.getPhoto).mockRejectedValue(new Error('Request to /photos/p1 failed: 404'));
    renderWithRouter(routes, ['/photos/p1']);
    expect(await screen.findByText('Request to /photos/p1 failed: 404')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to search/i })).toHaveAttribute('href', '/search');
  });
});
```

Run: `npx vitest run src/components/__tests__/PhotoDetail.test.tsx` → FAIL.

- [ ] **Step 4: Rewrite `src/components/PhotoDetail.tsx`**

```tsx
import {
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Divider,
  Group,
  Image,
  SimpleGrid,
  Skeleton,
  Stack,
  Text,
  Textarea,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { usePrefetchImage } from '../hooks/usePrefetchImage';
import { workerApiClient } from '../services/api/WorkerApiClient';
import { exposureSummary, formatPhotoDate, mapsUrl } from '../services/exif';
import { getOriginalImageUrl, getOriginalUrl } from '../services/originals';
import Lightbox from './Lightbox';

function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes == null) return null;
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <Box>
    <Text size="xs" c="dimmed" tt="uppercase">
      {label}
    </Text>
    <Text size="sm">{children}</Text>
  </Box>
);

const Section = ({ title, items, variant }: { title: string; items: unknown[]; variant?: 'light' | 'outline' }) =>
  items.length === 0 ? null : (
    <Box>
      <Title order={5} mb="xs">
        {title}
      </Title>
      <Group gap="xs">
        {items.map((item) => (
          <Badge key={String(item)} variant={variant ?? 'light'} size="lg" tt="none">
            {String(item)}
          </Badge>
        ))}
      </Group>
    </Box>
  );

const PhotoDetail = () => {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();

  const {
    data: photo,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['photo', id],
    queryFn: () => workerApiClient.getPhoto(id),
    enabled: id !== '',
  });

  const originalImage = photo ? getOriginalImageUrl(photo) : null;
  const originalStatus = usePrefetchImage(originalImage);
  const lightboxOpen = searchParams.get('lightbox') === '1';

  const openLightbox = () => navigate({ search: '?lightbox=1' }, { state: { lightbox: true } });
  const closeLightbox = () => {
    if ((location.state as { lightbox?: boolean } | null)?.lightbox) {
      navigate(-1);
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.delete('lightbox');
    setSearchParams(next, { replace: true });
  };

  if (isLoading) {
    return (
      <Stack>
        <Skeleton height={360} />
        <Skeleton height={120} />
      </Stack>
    );
  }

  if (error || !photo) {
    return (
      <Stack align="flex-start">
        <Text c="red">{error instanceof Error ? error.message : 'Photo not found'}</Text>
        <Anchor component={Link} to="/search">
          Back to search
        </Anchor>
      </Stack>
    );
  }

  const originalUrl = getOriginalUrl(photo);
  const date = formatPhotoDate(photo.dateTime);
  const gps = mapsUrl(photo);
  const exposure = exposureSummary(photo);
  const size = formatBytes(photo.fileSize);
  const dimensions = photo.width && photo.height ? `${photo.width} × ${photo.height}` : null;
  const albumHref = photo.album ? `/albums/${encodeURIComponent(photo.album)}` : null;
  const canGoBack = location.key !== 'default';
  const thumbnail = workerApiClient.thumbnailUrl(photo);
  const alt = photo.filename ?? photo.id;

  return (
    <Stack gap="lg">
      {canGoBack ? (
        <Anchor component="button" type="button" size="sm" onClick={() => navigate(-1)} w="fit-content">
          ← Back
        </Anchor>
      ) : (
        <Anchor component={Link} to={albumHref ?? '/search'} size="sm" w="fit-content">
          {albumHref ? '← Back to album' : '← Back to search'}
        </Anchor>
      )}

      <Card withBorder>
        <Group align="flex-start" wrap="wrap" gap="lg">
          <UnstyledButton
            onClick={openLightbox}
            aria-label="Open full-size photo"
            style={{ cursor: 'zoom-in', flex: '1 1 320px', maxWidth: '100%' }}
          >
            <Image
              src={thumbnail}
              alt={alt}
              fit="contain"
              radius="md"
              mah={600}
              bg="var(--mantine-color-default-hover)"
            />
          </UnstyledButton>

          <Stack gap="md" style={{ flex: '1 1 280px' }}>
            <Title order={3}>{photo.filename ?? 'Photo'}</Title>

            <SimpleGrid cols={2} spacing="sm">
              {date && <Field label="Taken">{date}</Field>}
              {photo.album && albumHref && (
                <Field label="Album">
                  <Anchor component={Link} to={albumHref}>
                    {photo.album}
                  </Anchor>
                </Field>
              )}
              {photo.cameraModel && <Field label="Camera">{photo.cameraModel}</Field>}
              {photo.lensModel && <Field label="Lens">{photo.lensModel}</Field>}
              {exposure.length > 0 && <Field label="Exposure">{exposure.join(' · ')}</Field>}
              {gps && (
                <Field label="Location">
                  <Anchor href={gps} target="_blank" rel="noopener noreferrer">
                    View on map
                  </Anchor>
                </Field>
              )}
              {dimensions && <Field label="Dimensions">{dimensions}</Field>}
              {size && <Field label="File size">{size}</Field>}
              {photo.format && <Field label="Format">{photo.format.toUpperCase()}</Field>}
              {photo.season && <Field label="Season">{photo.season}</Field>}
              {/* Unknown (null) is left out entirely rather than shown as "Unknown". */}
              {photo.hasWatermark != null && <Field label="Watermark">{photo.hasWatermark ? 'Yes' : 'No'}</Field>}
            </SimpleGrid>

            {originalUrl && (
              <Anchor href={originalUrl} target="_blank" rel="noopener noreferrer" size="sm">
                View Original
              </Anchor>
            )}
          </Stack>
        </Group>
      </Card>

      <Card withBorder>
        <Stack gap="md">
          {photo.description && (
            <Box>
              <Title order={5} mb="xs">
                Description
              </Title>
              <Text>{photo.description}</Text>
            </Box>
          )}
          {photo.environment && (
            <Box>
              <Title order={5} mb="xs">
                Environment
              </Title>
              <Text>{photo.environment}</Text>
            </Box>
          )}
          <Divider />
          <Section title="Subjects" items={photo.subjects} />
          <Section title="Tags" items={photo.tags} variant="outline" />
          <Section title="Colors" items={photo.colors} variant="outline" />
          <Section title="Patterns" items={photo.patterns} variant="outline" />
        </Stack>
      </Card>

      {(photo.suggestedCaption || photo.suggestedHashtags.length > 0) && (
        <Card withBorder>
          <Stack gap="sm">
            <Title order={5}>Suggested caption</Title>
            <Textarea value={photo.suggestedCaption ?? ''} readOnly rows={4} />
            {photo.suggestedHashtags.length > 0 && (
              <Group gap="xs">
                {photo.suggestedHashtags.map((tag) => (
                  <Badge key={tag} variant="light">
                    #{tag}
                  </Badge>
                ))}
              </Group>
            )}
            <Button
              w="fit-content"
              onClick={() => {
                const hashtags = photo.suggestedHashtags.map((t) => `#${t}`).join(' ');
                void navigator.clipboard.writeText(`${photo.suggestedCaption ?? ''}\n\n${hashtags}`.trim());
              }}
            >
              Copy to Clipboard
            </Button>
          </Stack>
        </Card>
      )}

      <Lightbox
        opened={lightboxOpen}
        onClose={closeLightbox}
        thumbnailSrc={thumbnail}
        originalSrc={originalImage}
        originalStatus={originalStatus}
        alt={alt}
        fallbackHref={originalUrl}
      />
    </Stack>
  );
};

export default PhotoDetail;
```

- [ ] **Step 5: Verify**

Run: `npm test && npm run lint && npm run build`
Expected: PASS. If `screen.getByRole('link', { name: 'Kanha 2026' })` is ambiguous because the Lightbox is not mounted, it should not be; if it is ambiguous, scope the query to the Album `Field`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Photo detail: Mantine port, original prefetch, lightbox, history-aware back

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 14: Remove Chakra, naming sweep, docs, final verification

**Files:**
- Modify: `package.json`, `package-lock.json`, `index.html`, `README.md`, `src/index.css`, `src/App.tsx`, `src/components/__tests__/smoke.test.tsx`, `docs/superpowers/specs/2026-10-14-pixdex-ui-overhaul-design.md`
- Create: `public/favicon.svg`
- Delete: `public/vite.svg`, `src/App.css`, `src/assets/react.svg` (if unreferenced)

- [ ] **Step 1: Confirm nothing imports Chakra**

Run: `grep -rn "@chakra-ui\|framer-motion\|@emotion" src test functions --include=*.ts --include=*.tsx`
Expected: only `src/App.tsx` (`ChakraProvider`). If any other file appears, port it first.

- [ ] **Step 2: Remove the Chakra provider and packages**

In `src/App.tsx`, delete the `ChakraProvider` import and wrapper so the tree is `MantineProvider > Notifications + QueryClientProvider > RouterProvider`. Then:

```bash
npm uninstall @chakra-ui/react @chakra-ui/icons @emotion/react @emotion/styled framer-motion
grep -rn "chroma-js" src || npm uninstall chroma-js @types/chroma-js
```

Expected: second command uninstalls chroma-js only if unused.

- [ ] **Step 3: Replace the favicon and strip Vite template leftovers**

`public/favicon.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0E8F9A"/>
      <stop offset="0.55" stop-color="#2563EB"/>
      <stop offset="1" stop-color="#7C3AED"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="url(#g)"/>
  <circle cx="32" cy="32" r="14" fill="none" stroke="#fff" stroke-width="5"/>
  <circle cx="32" cy="32" r="5" fill="#fff"/>
</svg>
```

In `index.html` change the icon link to `href="/favicon.svg"` and add `<meta name="theme-color" content="#0E8F9A" />`. Then:

```bash
git rm -f public/vite.svg src/App.css
grep -rn "react.svg\|App.css" src || git rm -f src/assets/react.svg
```

Replace `src/index.css` with only:

```css
body {
  margin: 0;
  min-height: 100vh;
}
```

- [ ] **Step 4: Naming sweep**

Run: `grep -rniE "pix ?dex" index.html README.md src | grep -v "pixdex-" | grep -v node_modules`
Fix every user-visible occurrence to exactly `PixdeX` (README title and headings, `index.html` `<title>`, any copy). Leave identifier uses (`package.json` name, paths, `pixdex` in code identifiers). Update `src/components/__tests__/smoke.test.tsx` so its text reads `PixdeX` in both the component and the assertion.

Then confirm: `grep -rn "PixDex" README.md index.html src` returns nothing.

- [ ] **Step 5: Bring the spec in line with what was built**

Edit `docs/superpowers/specs/2026-10-14-pixdex-ui-overhaul-design.md`:
- Routing section: remove the redirect sentence; state that `/search` with no params lists everything newest first and that old `/search?album=X` links still work as a filtered search.
- Theme section: replace the `ColorSchemeProvider` sentence with `MantineProvider defaultColorScheme="auto"` plus a header toggle (`useMantineColorScheme`).
- Phasing: add one sentence that Search, Albums, Dashboard and PhotoDetail were rewritten directly on Mantine in Phase 2 rather than ported first.

- [ ] **Step 6: Full verification**

Run, from the repo root:

```bash
npm run lint && npm test && npm run build
(cd worker && npm test)
(cd agent && npm run typecheck && npm test)
```

Expected: all PASS. Then run the app and check by hand against `.env` (read-only against your real worker):

```bash
npm run dev
```

Check, at desktop width and at 390px width (browser devtools):
1. Header is fully visible on mobile; burger opens the drawer with all links and Log out.
2. `/search?q=leopard&page=2&size=20`: form shows `leopard`, page 2 selected, size 20; click a result, then browser Back: same form and page.
3. `/albums` shows cover cards with counts and dates and paginates; clicking a card goes to `/albums/<name>` with its photos, newest first.
4. Photo detail: network tab shows the original requested once on load; clicking the photo opens the fullscreen lightbox; Esc closes it and the URL loses `?lightbox=1`; reload on `?lightbox=1` reopens it.
5. Light and dark both look right; header gradient is teal to blue to violet.
6. Tab title and header read `PixdeX`.

Report anything that does not match instead of declaring it done.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Remove Chakra, finish PixdeX naming and favicon, sync spec

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage**

| Spec item | Task |
|---|---|
| 1 Stack upgrade, Mantine | 1, 2, 3, 14 |
| 2 Deep links and restored state | 3 (data router), 8, 10, 11, 13 |
| 3 Paginated search | 8, 10 |
| 4 Rich paginated albums with cover | 5, 7, 11 |
| 5 Album page separate from Search | 6, 11 |
| 6 Mobile header | 3 |
| 7 Consistent PixdeX | 2 (`BRAND`), 12, 14 |
| 8 Aurora theme | 2, 3 |
| 9 Prefetch and lightbox | 7, 13 |
| Icons retained | 3 (`react-icons/md`) |
| Proxy passes `/albums` query | 5 |

**Placeholder scan:** none; the two places that depend on the shape of existing tests (Dashboard and DailySuggestion ports) say exactly which lines to change and what to keep.

**Type consistency:** `useListParams` returns `{ params, page, size, offset, update }` and is consumed identically in Tasks 10, 11. `ListPagination.onPage(page, replace?)` matches `update({ page }, { replace })` in the three pages. `getAlbumsPage`, `AlbumSummary`, `getOriginalImageUrl`, `PrefetchStatus` are defined in Tasks 7 and 13 before use in the components that import them.

**Review Focus coverage:** items 1 (Task 8 hook and pagination tests), 2 (Task 11 encoded-name tests), 3 (Task 11 null cover/date), 4 (Task 13 error and Drive tests), 5 (Task 10 whitespace test), 6 (Tasks 11 and 12 empty-state tests).
