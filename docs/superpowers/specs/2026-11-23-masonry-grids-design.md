# Masonry photo grids and album tiles - design

Date: 2026-11-23. Status: shipped, then revised twice after use on real data: the albums page went back to the classic card (only the sort icons stayed) and the masonry now ends flush by giving columns different widths (no cropping, page sizes exact, at most 4 columns). Scope: photo grids and the album listing. The photo detail page is
parked and gets its own brainstorm later.

## Intent

The owner wants to see more photos and less text. Today every photo card is a 240px letterboxed image plus a
text block (caption, 3-line description, date, camera, up to 5 tags, "View Original", optional footer button) and
every album card is a 180px letterboxed cover plus name, count, sharing info and a Share button. Text and buttons
use as much space as the image.

## Goals

- Photos fill the screen: tiles keep each photo's true aspect ratio (no `contain` letterboxing).
- Text is reduced to what helps scanning: a short caption and date. Description, tags, camera and "View Original"
  leave the grid (they stay on the detail page).
- One shared grid used by Search, Timeline, Album, Person and AI results, so they stay consistent.
- Album listing is cover-first, several albums per row.
- Works on desktop and on phones and tablets.

## Non-goals / anti-goals

- No photo detail page changes (parked).
- No infinite scroll, no pagination change (`ListPagination` and page sizes stay).
- No Worker, D1, migration or API change.
- Never hide an owner action permanently: owner actions must remain reachable on touch.
- Never show text the viewer cannot dismiss or that covers a face-heavy photo by default on touch.

## Decisions (agreed in conversation)

- Direction "B" on desktop: masonry columns, each tile its own aspect ratio, caption, date and a few tags fade in
  over a bottom gradient on hover.
- Direction "C" on touch: same masonry, plus one dimmed caption line under each tile (short caption only).
- Album listing: UNIFORM 4:3 tiles (not masonry: the album summary has no cover width or height, and uniform tiles keep
  names aligned), cover fills the tile, the name below it, count, date and sharing on hover (revised after review: they were first always visible over the cover), 2 to 5 per row.
- Sharing on album tiles: an overlapping avatar stack (up to 3, then "+N") at the bottom right of the cover for owner albums
  that are shared; the owner's avatar there for albums shared with you, plus the "Shared with you" chip. Always visible.
- Sort controls become icon groups with tooltips (no direction control: the API has none): albums (latest photo, name, photo count), album page
  (date, best rated), search (best match, best rated, date). On phones a single sort icon opens a menu with the current
  choice ticked. Offer only the sorts each page already supports.
- Album page owner action: a direct "Set as cover" icon button on each tile (current cover gets a Cover badge), no menu. The
  corner menu is kept only on the person page, where there are several face actions.
- Search tiles: the overlay shows the album name as a chip above the caption; the touch caption line shows the album
  name instead of the date. Not needed on the album page.
- Phones: 2 columns by default (today 1), with a small icon toggle between 1 and 2 columns on the photo grids.
- Choice between B and C is made by input capability (`@media (hover: hover)`), not by screen width, so a touch
  tablet gets C and a laptop with a narrow window gets B.

## My calls (not yet confirmed, please check)

- **Layout engine:** a small JS shortest-column component (`MasonryGrid`), not CSS columns. CSS columns fill top to
  bottom, which scrambles the date order the Timeline relies on. Each photo goes into the currently shortest
  column; heights come from `width / height` (known up front), so there is no layout shift. Photos with null
  width or height get a 4:3 placeholder ratio.
- **Columns:** 2 below 576px, 3 up to 992px, 4 up to 1400px, 5 above (gap 6px); album tiles 2, 3, 4, 5 in the
  same steps.
- **Owner actions on tiles:** small corner icon controls, only rendered when the existing gating allows it
  (`photo.canEdit`, the album's `role === 'owner'`, or the person's `canEdit`). On hover-capable devices they appear
  on hover and on keyboard focus; on touch they are always visible. They replace the labelled footer buttons. The AI
  results footer moves into the caption line or a menu, decided at build time.
- **Album Share button:** same corner button pattern, owner only.
- **Keyboard and screen readers:** the whole tile is one link to `/photos/:id`; caption and date are in the
  accessible name, so hover-only text is never the only source. Overlay also shows on `:focus-within`.
- **Image loading:** thumbnails use `loading="lazy"` with the reserved aspect ratio.

## Approaches considered

1. CSS multi-column: least code, but column-major order breaks date reading order. Rejected.
2. JS shortest-column component (chosen): about 60 lines plus a resize observer, keeps near row-major order, no
   layout shift.
3. CSS `grid-lanes` (native masonry): cleanest, but browser support is too thin. Revisit later.

## Parts

- `src/components/MasonryGrid.tsx`: generic, takes items with a ratio and a render function; column count from a
  width observer; assigns each item to the shortest column.
- `PhotoGrid.tsx`: uses `MasonryGrid`; the `footer` prop becomes an `actions` slot rendered in the corner menu.
- `PhotoCard.tsx`: becomes the tile (image, hover overlay, caption strip on touch). `AiResults.tsx` switches to
  the same tile.
- `AlbumCard.tsx` and `Albums.tsx`: cover-first tile, grid of 2 to 5 columns.
- Callers adjusted: `AlbumPhotos.tsx` (set cover), `PersonPage.tsx` (face footer), `Timeline.tsx`, `Search.tsx`.
- Tests: update `PhotoCard`/`Albums`/`PhotoReview`-adjacent tests; add `MasonryGrid` tests (shortest-column
  assignment, null dimensions, column count) and a check that gated actions stay hidden for non-owners.
- Docs: update `README.md`, `AGENTS.md` (Layout section) and `docs/` in the same commit; refresh
  `dev/mockApi.ts` photo dimensions if the mock lacks them; check light and dark with `PIXDEX_MOCK=1 npm run dev`.

## Performance review (CPU and D1)

- Worker CPU: no change. No route, query or payload changes.
- D1: 0 rows read or written beyond today. Page sizes and queries are unchanged.
- Client: layout math is O(photos on one page) (at most the existing page size); one resize observer per grid.
  Hover overlay is CSS only. Lazy loading reduces simultaneous thumbnail requests (thumbnails are one D1 read
  each through the Function, so fewer simultaneous loads is a mild improvement). Not measurable locally beyond
  visual checks.

## Left to the builder

Exact breakpoints, gradient strength, icon choice, menu component (Mantine `Menu`), transition timing, the AI
results footer placement, and the mock data adjustments.
