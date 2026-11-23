# Masonry Photo Grids and Album Tiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the text-heavy photo cards and album cards with image-first masonry tiles (hover overlay on hover-capable devices, one caption line on touch), uniform cover-first album tiles, and icon sort controls.

**Architecture:** One shared `MasonryGrid` (shortest-column assignment from each photo's `width / height`) renders `PhotoTile`s through `PhotoGrid`, used by Search, Timeline, Album, Person and AI results. Hover versus touch is decided in CSS with `@media (hover: hover)`, so the DOM always contains both the overlay and the caption line. Frontend only: no Worker, D1, API or migration change.

**Tech Stack:** React 19, Vite, Mantine 9 (`useMatches`, `useLocalStorage`, `Menu`, `ActionIcon`, `Tooltip`), react-icons (`react-icons/tb`), Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-23-masonry-grids-design.md`. Approved mockup: `.superpowers/brainstorm/*/content/full-pages-v2.html` (git-ignored; open it for visual reference).

## Global Constraints

- Photo detail page (`PhotoDetail.tsx`, `PhotoMeta.tsx` usage there) is NOT touched.
- No Worker, D1, API, migration or `ListPagination` change; page sizes unchanged.
- Hidden, never disabled: owner controls keep their gating (`photo.canEdit` for photo controls, album `role === 'owner'` for cover and Share, person `canEdit` for person controls).
- Columns: photos 2 below 576px, 3 from 576px, 4 from 992px, 5 from 1408px (Mantine `xs`, `md`, `xl`); gap 6px (8px from `md`). Phones (below 576px) can toggle 1 or 2 columns. Album tiles use the same counts (2, 3, 4, 5), uniform 4:3.
- A photo with null `width` or `height` uses ratio 4/3; clamp every ratio to the range 0.4 to 3.
- Tile image: `loading="lazy"`, `object-fit: contain` on a neutral background inside an `aspect-ratio` box (safety net for old thumbnails stored in the raw sensor frame).
- Text on tiles: hover-capable devices show overlay (caption, date, up to 3 tags; on Search also an album chip); touch shows no overlay and one caption line under the tile (short caption, then date; on Search the album name instead of the date). The whole tile is one link to `/photos/:id` with an accessible name from the caption.
- Styles live in `src/index.css` (existing tokens, `--pixdex-ink-*`), classes prefixed `pdx-`; light and dark must both work.
- No em dashes in any text or comment. Never call an external avatar service (use `UserAvatar`/`AvatarStack`).
- Sort controls: no direction control (the API has none). Only the sorts a page already offers.
- Update `README.md`, `AGENTS.md` (Layout section) and `docs/` in the final task's commit; run `graphify update .` after code changes.
- Pre-commit hook runs the touched suites; do not bypass it. Commit after each task.

## Review Focus

- Photos with null or zero `width`/`height` must not produce NaN/Infinity heights or an empty column (ratio 4/3 fallback).
- A page with fewer photos than columns, and an empty page, must render without empty-column errors or layout crashes.
- Hover-only text must never be the only source: caption and date must exist in the DOM/accessible name without hover (screen reader, keyboard focus shows the overlay via `:focus-within`).
- A viewer (non-owner) must never see cover, Share or person-face controls on tiles (existing gating tests must still pass after the UI change).
- Column count changes (resize, phone toggle) must keep every photo exactly once and in the same relative order per assignment rules.

## File Structure

- Create `src/components/masonry.ts`: pure `photoRatio`, `assignColumns`.
- Create `src/components/MasonryGrid.tsx`: generic masonry component.
- Create `src/hooks/usePhoneColumns.ts`: 1 or 2 columns on phones (persisted).
- Create `src/components/PhotoTile.tsx` (replaces `PhotoCard.tsx`, `git mv`) and its test.
- Modify `src/components/PhotoGrid.tsx`.
- Create `src/components/SortIcons.tsx`: icon sort control (desktop group, phone menu).
- Create `src/components/ColumnsToggle.tsx`: phone-only 1/2 column toggle.
- Modify `src/components/AlbumCard.tsx`, `Albums.tsx`.
- Modify callers: `Search.tsx`, `Timeline.tsx`, `AlbumPhotos.tsx`, `PersonPage.tsx`, `AiResults.tsx`.
- Modify `src/index.css`, `dev/mockApi.ts`, tests, docs.

---

### Task 1: Masonry layout core

**Files:**
- Create: `src/components/masonry.ts`, `src/components/MasonryGrid.tsx`, `src/hooks/usePhoneColumns.ts`
- Test: `src/components/__tests__/masonry.test.ts`, `src/components/__tests__/MasonryGrid.test.tsx`

**Interfaces:**
- Produces:
  - `photoRatio(photo: { width: number | null; height: number | null }): number` (width/height clamped to [0.4, 3]; 4/3 when either is null, 0 or not finite).
  - `assignColumns(ratios: number[], columns: number): number[][]` (returns, per column, the item indexes in input order; each item goes to the column with the smallest summed `1 / ratio` so far, ties to the leftmost).
  - `MasonryGrid<T>({ items, ratioOf, keyOf, renderItem, columns }: { items: T[]; ratioOf: (item: T) => number; keyOf: (item: T) => string; renderItem: (item: T) => ReactNode; columns: number })`, renders a flex row of column `div`s (`data-testid="masonry-column"`), gap from CSS class `pdx-masonry`.
  - `usePhotoColumns(): number` (Mantine `useMatches({ base: phone, xs: 3, md: 4, xl: 5 })`, where `phone` is 1 or 2).
  - `usePhoneColumns(): [1 | 2, () => void]` (persisted with `useLocalStorage` under key `pixdex.phoneColumns`, default 2, anything other than 1 or 2 reads as 2).

- [ ] **Step 1: Write failing tests.** `masonry.test.ts`: `photoRatio` returns 4/3 for `{width:null,height:100}`, `{width:0,height:0}`, and clamps `{width:100,height:1000}` to 0.4 and `{width:1000,height:10}` to 3. `assignColumns([1,1,1,1], 2)` equals `[[0,2],[1,3]]`; `assignColumns([0.5, 2, 2, 2], 2)` equals `[[0],[1,2,3]]` (tall first item keeps column 0 busy); `assignColumns([], 3)` equals `[[],[],[]]`; fewer items than columns leaves trailing empty arrays; every index appears exactly once for 50 random ratios and 5 columns. `MasonryGrid.test.tsx`: with 5 items and `columns={2}` renders two `masonry-column` elements whose children, read in order, hold every `keyOf` once; with `columns={3}` and 2 items renders 3 columns (one empty) without throwing.
- [ ] **Step 2: Run** `npx vitest run src/components/__tests__/masonry.test.ts src/components/__tests__/MasonryGrid.test.tsx`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the three files per the signatures above. `assignColumns` is the O(n x columns) loop; `MasonryGrid` memoizes the assignment on `items` and `columns`.
- [ ] **Step 4: Run** the same command. Expected: PASS. Also `npm run lint`.
- [ ] **Step 5: Commit** `feat(ui): masonry layout core`.

---

### Task 2: PhotoTile and PhotoGrid

**Files:**
- Move: `src/components/PhotoCard.tsx` to `src/components/PhotoTile.tsx` (`git mv`); move `__tests__/PhotoCard.test.tsx` to `__tests__/PhotoTile.test.tsx`
- Modify: `src/components/PhotoGrid.tsx`, `src/index.css`
- Test: `src/components/__tests__/PhotoTile.test.tsx`, `src/components/__tests__/PhotoGrid.test.tsx`

**Interfaces:**
- Consumes: `photoRatio`, `MasonryGrid`, `usePhotoColumns` (Task 1); `workerApiClient.thumbnailUrl`, `shortDescription` (existing).
- Produces:
  - `PhotoTile({ photo, actions, note, showAlbum }: { photo: SerializedPhoto; actions?: ReactNode; note?: string; showAlbum?: boolean })`: a `Link` to `/photos/${photo.id}` wrapping the image (`aria-label` is caption or filename plus date), the overlay (`pdx-tile-overlay`: optional album chip when `showAlbum` and `photo.album`, caption (`shortCaption ?? shortDescription(description, 60)`), formatted date, up to 3 tags, `note` as a dimmed line), the caption line (`pdx-tile-cap`: caption then `showAlbum && photo.album ? photo.album : date`, or `note` when given), and an `actions` slot positioned top right (`pdx-tile-actions`, sits OUTSIDE the link so buttons are not nested in an anchor).
  - `PhotoGrid({ photos, actions, note, showAlbum }: { photos: SerializedPhoto[]; actions?: (photo: SerializedPhoto) => ReactNode; note?: (photo: SerializedPhoto) => string | undefined; showAlbum?: boolean })` (the old `footer` prop is removed). Uses `MasonryGrid` with `usePhotoColumns()`.
  - CSS in `index.css`: `.pdx-masonry` (flex row, gap), `.pdx-tile` (relative, radius), `.pdx-tile-overlay` (gradient, `opacity: 0`, visible on `.pdx-tile:hover` and `:focus-within`), `.pdx-tile-cap` (hidden), and `@media (hover: none) { overlay display none; .pdx-tile-cap display block; .pdx-tile-actions opacity 1 }`; actions are `opacity: 0` on hover-capable devices until `:hover`/`:focus-within`.

- [ ] **Step 1: Write failing tests (`PhotoTile.test.tsx`, replacing the old PhotoCard tests).** Cases: renders the thumbnail with `src` from `workerApiClient.thumbnailUrl` and `loading="lazy"`; link to `/photos/p1`; overlay and caption line contain the caption and date text (both in the DOM); description, camera and "View Original" are NOT rendered; at most 3 tags; with `showAlbum` and `photo.album = 'Goa 2024'` the album name appears in the overlay and in the caption line instead of the date; `note` appears in the overlay and replaces the caption-line tail; `actions` content is rendered outside the link (`link.contains(button)` is false). `PhotoGrid.test.tsx`: renders one tile per photo, `actions(photo)` called per photo, `showAlbum` forwarded.
- [ ] **Step 2: Run** `npx vitest run src/components/__tests__/PhotoTile.test.tsx src/components/__tests__/PhotoGrid.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** `PhotoTile`, `PhotoGrid` and the CSS per the interfaces. Remove `PhotoMeta` usage from the tile (keep `PhotoMeta.tsx`, the detail page still uses it).
- [ ] **Step 4: Run** the two tests; expected PASS. Do not run other suites yet (callers break until Task 3).
- [ ] **Step 5: Commit** `feat(ui): image-first photo tile and masonry PhotoGrid`.

---

### Task 3: Move callers to the new grid

**Files:**
- Modify: `src/components/Search.tsx` (~line 388), `Timeline.tsx` (~289), `AlbumPhotos.tsx` (~181), `PersonPage.tsx` (~22-80, 330), `AiResults.tsx`
- Test: `__tests__/AlbumPhotos.test.tsx`, `PersonPage.test.tsx`, `Search.test.tsx`, `Timeline.test.tsx`

**Interfaces:**
- Consumes: `PhotoGrid`/`PhotoTile` props from Task 2.
- Produces: no new exports. Behavior: 
  - Search: `<PhotoGrid photos=... showAlbum />`.
  - Timeline: plain `<PhotoGrid photos=... />`.
  - AlbumPhotos: `actions` returns, for the album owner only, a Mantine `ActionIcon` with `aria-label="Set as cover"` (disabled and replaced by a gold `Badge` "Cover" when `photo.id === coverId`), same mutation and loading state as today; an image-type icon (not a star, which means "rated").
  - PersonPage: `PersonFaceFooter` becomes `PersonFaceActions` (same queries and mutations): when `person.canEdit` and a candidate exists, renders an "Auto" `Badge` when `auto`, and a Mantine `Menu` (trigger `ActionIcon` `aria-label="Photo actions"`) with items `Set as cover` (replaced by a disabled item `Current cover` when `isCover`) and, when `auto`, `Not {auto.personName}`; mutation errors shown as a Mantine notification or `Text` inside the menu dropdown.
  - AiResults: uses `PhotoGrid` with `note` built from `item` (`matched: <hits>`, then `Text space: N% (side)` when present, then `Rating: x.x`, joined with ` · `); delete `ResultFooter` and the direct `SimpleGrid`.

- [ ] **Step 1: Update tests first.** AlbumPhotos: owner still finds a button named `/set as cover/i` and clicking it calls `setAlbumCover` as before; viewer sees neither the button nor a Cover badge action; the current cover tile shows "Cover". PersonPage: replace button lookups by opening the `Photo actions` menu (`fireEvent.click`) then `menuitem` `Set as cover` / `Not Asha`; "Auto" badge visible without opening; a non-owner person (`canEdit: false`) has no `Photo actions` button; current-cover photo shows a disabled `Current cover` item. Search: the album name appears for a result with `album` set. Fix any Timeline/Search assertions that looked for descriptions or "View Original" on cards.
- [ ] **Step 2: Run** `npx vitest run src/components/__tests__/AlbumPhotos.test.tsx src/components/__tests__/PersonPage.test.tsx src/components/__tests__/Search.test.tsx src/components/__tests__/Timeline.test.tsx`. Expected: FAIL where the new UI is asserted.
- [ ] **Step 3: Implement** the caller changes above.
- [ ] **Step 4: Run** the same command plus `npm run lint && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): use masonry tiles on search, timeline, album, person and AI results`.

---

### Task 4: Icon sort controls and phone column toggle

**Files:**
- Create: `src/components/SortIcons.tsx`, `src/components/ColumnsToggle.tsx`
- Modify: `Albums.tsx`, `AlbumPhotos.tsx`, `Search.tsx`, `PersonPage.tsx` (replace the sort `Select`s)
- Test: `__tests__/SortIcons.test.tsx`, `ColumnsToggle.test.tsx`; update `Albums.test.tsx`, `AlbumPhotos.test.tsx`, `Search.test.tsx`, `PersonPage.test.tsx` sort assertions

**Interfaces:**
- Produces:
  - `SortIcons<V extends string>({ options, value, onChange, label }: { options: { value: V; label: string; icon: IconType }[]; value: V; onChange: (v: V) => void; label: string })`: from `xs` up, an `ActionIcon.Group` of `ActionIcon`s each in a `Tooltip` with `aria-label={option.label}` and `aria-pressed`; below `xs`, one `ActionIcon` (`aria-label={label}`, `TbArrowsSort`) opening a `Menu` of `Menu.Item`s with the current one ticked. Icons from `react-icons/tb`: date `TbCalendar`, rated `TbStar`, name `TbSortAZ`, count `TbHash`, best match `TbTarget`.
  - `ColumnsToggle()`: renders only below `xs` (`hiddenFrom="xs"`), an `ActionIcon` `aria-label="Switch to 1 column"` or `"Switch to 2 columns"` using `usePhoneColumns`.
  - Each page keeps its current `SORT_OPTIONS` values, labels and URL handling (`update({ sort: ... }, { resetPage: true })`; default value maps to no param exactly as today); labels are the existing ones ("Newest first", "Best rated", "Alphabetical", "Most photos", "Best match"). `ColumnsToggle` appears next to sort on AlbumPhotos, Search, PersonPage and Timeline-free pages only (Timeline has no sort control: add the toggle beside its existing filters if there is room, otherwise skip it there and say so).

- [ ] **Step 1: Write failing tests.** `SortIcons`: renders one button per option named by label; the active one has `aria-pressed="true"`; clicking another calls `onChange` with its value (use a `matchMedia` stub that matches `(min-width: ...)` for the desktop branch, or assert on the button group); phone branch via the default jsdom stub (`matches: false`) renders a single `Sort` button that opens a menu whose items call `onChange`. `ColumnsToggle`: default shows "Switch to 1 column"; clicking changes the label and persists `pixdex.phoneColumns`. Page tests: replace `Select` lookups with the icon buttons and keep the same expected `searchPage`/`getAlbumsPage` call args (`sort` mapping unchanged, `relevance` sends no `sort`).
- [ ] **Step 2: Run** `npx vitest run src/components/__tests__/SortIcons.test.tsx src/components/__tests__/ColumnsToggle.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** both components and swap them into the four pages.
- [ ] **Step 4: Run** `npx vitest run src/components` and `npm run lint && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): icon sort controls and phone column toggle`.

---

### Task 5: Album tiles (uniform)

**Files:**
- Modify: `src/components/AlbumCard.tsx`, `Albums.tsx`, `src/index.css`
- Test: `__tests__/Albums.test.tsx` (update), `__tests__/AlbumCard.test.tsx` (create)

**Interfaces:**
- Consumes: `AvatarStack`, `UserAvatar`, `ShareAlbumModal` (existing, unchanged).
- Produces: `AlbumCard({ album }: { album: AlbumSummary })` keeps its props and the link `to` (`/albums/${encodeURIComponent(name)}`, `state.albumsList`). Layout: 4:3 `aspect-ratio` tile, cover image `object-fit: cover` (a missing cover keeps the `MdPhoto` placeholder), name (1 line clamp) and `N photos` plus formatted date over a bottom gradient (always visible); viewer album: "Shared with you" chip top left and `UserAvatar` of `ownerEmail` bottom right; owner album with `sharedWith.length > 0`: `AvatarStack` (max 3) bottom right; owner only: a corner `ActionIcon` `aria-label="Share"` (outside the link; on hover-capable devices shown on hover or focus, always on touch) that opens `ShareAlbumModal` exactly as before. `Albums.tsx` grid: `SimpleGrid cols={{ base: 2, xs: 3, md: 4, xl: 5 }} spacing="sm"`.

- [ ] **Step 1: Write failing tests.** `Albums.test.tsx`: cover `src` still from `thumbnailUrl`; the old "never cropped" `contain` assertion is replaced by one asserting the tile image uses `cover`; links unchanged (encoded names). `AlbumCard.test.tsx`: owner with `sharedWith: ['a@x.com','b@x.com']` shows avatars (aria-labels are the emails) and a `Share` button that opens the modal; owner with no shares shows no avatars; viewer shows "Shared with you", the owner's avatar and NO `Share` button; share button is not inside the link.
- [ ] **Step 2: Run** `npx vitest run src/components/__tests__/Albums.test.tsx src/components/__tests__/AlbumCard.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** `AlbumCard` and the grid change.
- [ ] **Step 4: Run** the same command and `npm run lint && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): uniform cover-first album tiles`.

---

### Task 6: Mock data, visual check, docs

**Files:**
- Modify: `dev/mockApi.ts` (~line 107), `README.md`, `AGENTS.md` (Layout section: describe `MasonryGrid`, `PhotoTile`, `SortIcons`, hover vs touch rule, phone columns toggle, that `footer` became `actions`/`note`), `docs/architecture.md` if it mentions card layouts, `docs/development.md` only if needed; update `docs/superpowers/specs/2026-11-23-masonry-grids-design.md` (remove the direction arrow, record the final component names)

- [ ] **Step 1:** In `dev/mockApi.ts`, vary mock photo dimensions across portrait (2:3), square, 4:3, 3:2 and panorama (16:9) instead of only 1:1 and 3:2.
- [ ] **Step 2:** Run `PIXDEX_MOCK=1 npm run dev` and check Search, Timeline, an album page, a person page, the albums page in the browser (Chrome DevTools MCP): desktop 1440px (hover shows overlay), phone 375px with touch emulation (caption line, always-visible corner actions, 2 columns, toggle to 1), light and dark. Fix any visual bug found; record what was checked.
- [ ] **Step 3:** Update docs listed above (no em dashes), including the performance review: Worker CPU 0, D1 0 rows, client layout O(page size).
- [ ] **Step 4: Run the full verification:** `npm test && npm run lint && npm run build`; then `cd worker && npm test && npm run typecheck` is unaffected (skip) ; `graphify update .`. Expected: all pass.
- [ ] **Step 5: Commit** `docs: masonry grids, tiles and sort icons`.
