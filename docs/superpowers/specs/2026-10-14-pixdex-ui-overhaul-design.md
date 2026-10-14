# PixdeX UI overhaul: design

Date: 2026-10-14
Status: draft, awaiting review

## Goals

1. Move the frontend to a current, maintained stack (Mantine 9, React 19, Router 7, Vite 8).
2. Make every page deep-linkable. Back/forward restores form values, page and results.
3. Paginate search results (default 10 per page, configurable).
4. Richer, paginated album listing with cover photos.
5. Separate the album photo listing from Search.
6. Fix the broken mobile header.
7. Name the product "PixdeX" consistently.
8. Replace the green header with the "Aurora" theme (teal to blue to violet), consistent via tokens.
9. Prefetch the original on the photo detail page and open it in a lightbox on click.

## Non-goals

- No change to ingest, the agent, D1 schema or auth.
- No zoom/swipe lightbox package in this round (Modal only).
- No server-side sorting beyond `sort=date` for album pages.

## Phasing

Each phase ends with `npm test`, `npm run lint` and `npm run build` green.

- **Phase 0, dependency bump on Chakra 2:** React 19, react-router-dom 7, Vite 8 (+ `@vitejs/plugin-react`), Vitest 5, jsdom, TypeScript, TanStack Query, ESLint/typescript-eslint, testing-library. No UI change.
- **Phase 1, UI kit swap** (Search, Albums, Dashboard and PhotoDetail were rewritten directly on Mantine in Phase 2 instead of being ported 1:1 first): remove Chakra, emotion, framer-motion and `@chakra-ui/icons`. Add `@mantine/core`, `@mantine/hooks`, `@mantine/notifications`. Port the 7 components and 5 component tests 1:1. Introduce the Aurora theme and `BRAND` constant.
- **Phase 2, features:** items 2 to 9 on the new stack.

## Routing and state (items 2, 5)

Switch from `BrowserRouter` to `createBrowserRouter`/`RouterProvider` so `ScrollRestoration` works. The URL is the single source of truth. Components derive form values from `useSearchParams` and write back to it.

| Route | Params | Page |
|---|---|---|
| `/` | none | Dashboard |
| `/albums` | `page`, `size` | Album grid |
| `/albums/:name` | `page`, `size` | Photos in one album |
| `/search` | `q`, `album`, `page`, `size` | Search results |
| `/photos/:id` | `lightbox=1` | Photo detail, optional lightbox open |
| `/daily` | none | Daily pick |

- `:name` is URL-encoded. There is no redirect from `/search?album=X`: Search keeps its album filter, so an old link still works as a filtered search.
- Search always fetches from the URL. With no params it lists everything newest first (paginated); a whitespace-only `q` counts as empty. `page` and `size` default to 1 and 10 and are omitted from the URL when default.
- Changing `q`, `album` or `size` resets `page` to 1. Page changes use `replace: false` so back steps through pages.
- The photo "Back" link uses history back when the previous entry is in-app, otherwise falls back to `/albums/:album` or `/search`.
- TanStack Query keeps previous results (`placeholderData: keepPreviousData`) so paging does not flash empty.

## Pagination (item 3)

The worker `/search` already returns `{results, total}` with `limit`/`offset`, ordered by `bm25(photos_fts)` then `last_indexed DESC`. No worker change is needed for this item.

- Page size options 10, 20, 50 (default 10), via `size` in the URL. Max stays 100 on the worker.
- Mantine `Pagination` plus a size `Select`, with "Showing a to b of total".
- All matches are reachable across pages; with 50+ matches that is 5+ pages at the default size.

## Albums (items 4, 5)

### Worker

`GET /albums?limit&offset` returns:

```ts
{
  albums: Array<{
    name: string;
    photoCount: number;
    coverPhotoId: string;
    coverThumbnailUrl: string | null;
    latestDate: string | null; // newest photo date_time in the album
  }>;
  total: number; // distinct albums
}
```

- Cover is the newest photo by `date_time`, falling back to `last_indexed`, ties broken by `id`, so it is stable.
- Default `limit` 12, max 48. Ordered by `latestDate DESC, name`.
- `GET /albums?names=1` keeps returning `{albums: string[]}` for the Search album dropdown.
- `/search` gains optional `sort=date` (`ORDER BY date_time DESC, last_indexed DESC`) used by the album page. Default ordering is unchanged.
- The Pages proxy allowlist `^albums$` already matches paths without a query string; add a test that `?limit` and `?names` pass through.

### Frontend

- **Albums page:** responsive grid of cards: cover image (4:3, `object-fit: cover`), name, photo count, latest date. Mantine `Pagination` and size selector (12/24/48).
- **Album page `/albums/:name`:** header with name and count, photo grid using the same `PhotoCard` as Search, paginated, `sort=date`.
- **Search page:** keeps its album filter dropdown (from `names=1`) and no longer doubles as the album page.
- Extract a shared `PhotoCard` and `PhotoGrid` used by Search and Album pages.

## Photo detail and lightbox (item 9)

`getOriginalUrl` returns a Drive viewer page (HTML) for `google_drive` photos and a same-origin `/api/originals/:id` image for `local` photos. Only `local` originals can be prefetched or shown in a lightbox.

- On detail mount, for `local` photos, preload the original (`new Image()`), which the browser caches (`max-age=3600` already set by the proxy).
- Clicking the main image opens a fullscreen Mantine `Modal` showing the thumbnail immediately and swapping to the original on load. `?lightbox=1` makes it deep-linkable; Esc and close remove the param.
- On error (502 when the machine hosting originals is offline), or for Drive photos: keep the thumbnail in the lightbox and show an "Open original" link (Drive or originals URL).
- Non-image originals (for example RAW) fall back the same way via `onError`.

## Header, naming, theme (items 6, 7, 8)

### Header

Mantine `AppShell.Header` with a burger and `Drawer`/`AppShell.Navbar` below the `sm` breakpoint. Logo and burger always visible, nav and logout inside the drawer on mobile. Header height 60.

### Icons

Keep `react-icons/md`. The existing nav icons (`MdHome`, `MdAlbum`, `MdSearch`, `MdPhoto`, `MdLogout`) are retained and rendered as plain components. New UI uses the same Material set for consistency (for example `MdChevronLeft`/`MdChevronRight`, `MdClose`, `MdMenu`, `MdOpenInNew`, `MdLightMode`/`MdDarkMode`). Only `@chakra-ui/icons`, which nothing imports, is removed.

### Naming

Single `BRAND = 'PixdeX'` constant used by header, `<title>` and docs. Replace "PixDex"/"pixdex" in user-visible text (index.html, README, docs headings). Lowercase `pixdex` stays where it is an identifier (package name, repo, paths). Replace the Vite favicon with a PixdeX mark.

### Theme: Aurora

Defined once in `src/theme.ts` via `createTheme`; no component sets raw colours.

| Token | Value |
|---|---|
| Primary (teal) | `#0E8F9A` |
| Gradient mid (blue) | `#2563EB` |
| Gradient end (violet) | `#7C3AED` |
| Accent (cyan) | `#22D3EE` |
| Light surface | `#F4FAFD` |
| Dark surface | `#0B1620` |

- Header: `linear-gradient(100deg, teal, blue 55%, violet)`.
- Mantine `primaryColor: 'aurora'` with a 10-shade scale generated around the teal; `defaultGradient` set to the header gradient.
- Neutral surfaces keep photos the loudest element; colour only in header, buttons, tags, focus rings.
- Light and dark via `MantineProvider defaultColorScheme="auto"` (follows the system) with a toggle in the header (`useMantineColorScheme`).
- Fonts: Bricolage Grotesque (display) and DM Sans (body) via Google Fonts, system fallbacks.

## Testing

- Keep and port existing component tests. Add tests for: URL to form state round trip, back navigation restoring Search state, pagination controls and page reset, album grid and album page, lightbox open/close and fallback, header at mobile width.
- Worker: tests for `/albums` rich shape, `names=1`, pagination bounds, cover selection, and `sort=date`.
- Proxy: allowlist test for `/albums` with query strings.

## Risks

- Chakra to Mantine port may change test selectors; tests are ported in Phase 1 before features.
- Mantine 9 requires React 19.2 (hence Phase 0).
- Cover-photo query cost grows with the library; mitigated by `LIMIT`/`OFFSET` on the album list and a `date_time` index if profiling shows a need.
