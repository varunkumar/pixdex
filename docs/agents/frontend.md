# Frontend: layout, photo grids, navigation and search

Agent notes. Read this file before you change this area. Update it with each change.
The core rules are in [`AGENTS.md`](../../AGENTS.md). Paths are relative to the repository root.

- `src/` - React 19 + Vite + Mantine frontend (calls same-origin `/api/*`);
  the Search page is one omnibox (`src/components/Search.tsx`; bar `src/components/omnibox/Omnibox.tsx`, panel `SuggestionPanel.tsx`,
  data `src/hooks/useOmniboxData.ts`, matcher `src/services/omnibox/matcher.ts`, URL state `src/services/omnibox/urlState.ts`, colours
  `src/components/chipStyle.ts`, dark-mode ink vars `--pixdex-ink-*` in `src/index.css`) with a plain mode and an AI mode (Chrome Prompt API only,
  client side; "Ask AI" / Cmd+Enter and the plain-mode "Add keywords" button, which sets `mode=ai` so keywords can be typed without the
  model, exist only where supported): AI result cards in `src/components/AiResults.tsx`, logic in
  `src/services/aiSearch/`, support gate in `src/hooks/usePromptApiSupport.ts`. In AI mode the page button is "Search again" (commits the
  keyword draft through the `KeywordRowHandle` ref, then re-runs the keywords without the model; Enter in the bar stays a plain search). `/ai-search` is only a redirect
  (`src/components/LegacyAiRedirect.tsx`) to `/search?mode=ai` (old `people=0` becomes `hidePeople=0`; without support the AI params are
  stripped); there is no AI Search nav entry. AI params: `mode=ai`, `q`, `kw`, `hidePeople=0`, `room=0`. `dev/mockApi.ts` is the dev-only dummy API
- Photo grids (`src/components/MasonryGrid.tsx`, `masonry.ts`, `PhotoGrid.tsx`, `PhotoTile.tsx`, `AlbumCard.tsx`, `SortIcons.tsx`, `ColumnsToggle.tsx`,
  `src/hooks/usePhoneColumns.ts`; styles `pdx-*` in `src/index.css`): masonry from each photo's `width / height` (null or zero is 4/3, clamped 0.4 to 3), columns
  2 / 3 / 4 at 0 / 576px / 992px, phones switch between 1 and 2 columns (localStorage `pixdex.phoneColumns`). Hover-capable devices get an overlay
  (compact: the title with its date on one line and one row of tags, or the AI note; the album name on Search and the person page sits at the top left as plain white text with a shadow, no pill), touch devices one caption line (`@media (hover: none)`); both are always in the DOM. `PhotoGrid` props are `badges` (always visible, top left: the Cover badge), `mark`, a small sparkle before the title in the hover text (`pdx-tile-mark`, labelled "Matched automatically" for an auto-matched face on the person page; touch shows a plain sparkle in the caption line), no loud "Auto" label, `actions` (hover-only on a mouse, top right), `note`,
  `showAlbum` (the old `footer` is gone); a touch screen next to a mouse (`any-pointer: coarse`) also gets the caption line and always-visible actions. Icon-only controls carry their photo or album in the accessible name ("Set as cover: <caption>", "Photo actions for <caption>"). The albums page keeps the original `AlbumCard` (bordered card, letterboxed 180px cover, name, count, date, avatar stack, Share button; grid 1 / 2 / 3 / 4 columns) with `SortIcons`; an experiment with image-first album tiles was reverted. The page size is always exactly the selector's value (12, 24, 48): no rounding to the column count. Photo columns are 1 or 2 (phone), 3 and 4 (never 5, so 12 photos still give 3 per column). `MasonryGrid` balances the columns (`balanceColumns`: greedy deal, then moves and swaps between any two columns while the sum of squared heights falls) and gives every column a width proportional to 1 / its height (`columnGrow`, gap included), so all columns end on the same line with tiles in their exact shape; tiles also grow a hair (`flex-grow` by height, `object-fit: cover`) to absorb the pixel gaps. That only happens when `planWidths` says the grid can end flush: every column is filled and the relative widths stay within 0.6 to 1.6 of a normal column. A short page (fewer photos than columns) keeps fixed columns about one normal column wide (`--pdx-col`, widths clamped 0.8 to 1.25), and extreme shapes fall back to equal columns; in both cases tiles are never stretched, cropped or upscaled to chase a flush edge (`data-flush="false"`, `object-fit: contain`), so the bottom edge is uneven. Empty columns are not rendered. Tile shape comes from the stored `width / height`, which the agent used to record in the raw sensor frame while thumbnails are upright (a phone portrait shot got a landscape tile). `extractExifData` now reports upright dimensions (swapped for EXIF orientation 5 to 8), and for photos indexed before that `PhotoGrid` reads the thumbnail's natural size on load: when its portrait/landscape orientation disagrees with the stored size (near-square photos are skipped) the tile is re-shaped and the shape is remembered in localStorage `pixdex.thumbRatios` (`useThumbRatios`, newest 3000). A one-time reflow per such photo per browser. People has `SortIcons` too. Sort is `SortIcons` (no direction). Frontend only: no Worker CPU, D1 or API change.
- Person page tabs (`PersonPage.tsx`): "Photos" and "Faces (N)", `tab=faces` (absent is Photos). Both share the sort and
  page; the columns control shows only on Photos; no tabs for a person with no photos. `FaceGrid.tsx` draws a list of
  square tiles (`pdx-faces`) in even rows that fill the width. It measures its width (`ResizeObserver`, first before
  paint) and `faceRows` (`faceRows.ts`) uses the fewest rows with tiles of 96px or more (3 across minimum on a narrow
  phone; gap 8px below 544px, then 16px). Row counts differ by one at most, so tiles in two rows can differ in size. A
  single row caps tiles at 192px (the crop size), so a few faces do not fill the width. Without a measured width (tests)
  the fixed 96px CSS grid applies. The
  touch caption is the date, or the caption if there is no date) with the photo tile classes and the same `badges`,
  `mark` and `actions` places; tiles come from `faceItems` (`services/faces.ts`). The owner has one "Face actions" menu
  per tile (`single` on `PersonFaceActions`); under 96px a container query moves the badge to the bottom. A face without
  a crop is an `img` of the thumbnail, sized and placed by percentage. The first 8 faces load at once. No Worker change.
- Tabs that live in the address (album and person pages): the list has an `aria-label`, and
  `activateTabWithKeyboard={false}`, because each tab change adds a history entry. Enter or Space selects.
- Touch targets and image loading: on `pointer: coarse`, the hit area of a tile action button is 44px (28px
  drawn). The buttons stay in a row: panorama tiles are low. `PhotoGrid` loads the top tile of each column at once; all other tiles are lazy.
- Back navigation (frontend): state a person expects to find again after Back goes in the address when it is a page
  number or filter (`useListParams`; People unnamed groups use `groups` and `groupSize`, with `keepScroll`), otherwise
  in `useHistoryState` (per history entry, browser memory: review grid page and ticks, "Ignored faces" open, person
  suggestions). Never plain `useState` for these. In-page back links return to the last shown address of the target
  (`useRememberAddress` / `useLastAddress`; Albums, People and person pages). Use `BackLink` for these links. Its text names
  the destination ("← All albums", "← All people", the person's name, "← To review"). The Access tab is in the URL
  (`?status=`).
- UI patterns (use these, and do not add a second variant):
  - Cover: use `CoverBadge` (blue `#2563EB`) and `SetCoverButton` on album tiles and person tiles.
  - A face row on the photo page keeps a text button with the same icon.
  - A person tile shows the "Photo actions" menu only for an automatic match ("Confirm X", "Not X").
  - Confirm a destructive action with `InlineConfirm` (delete a person, revoke access). Focus starts on Cancel.
  - Show loading with `PageLoading` and a label. The photo page and Daily pick keep skeletons. Dashboard counts show "-".
  - Copy text with `copyText` (`services/copy.ts`). Write labels in sentence case.
  - Each page calls `usePageTitle` and has exactly one `h1`. To change a heading level, set `order`. Keep the look with `size`.
  - Give a text link that is a control the class `pdx-target`. Controls are at least 24px by 24px.
  - The Timeline month rail is the known exception to that size.
  - Name each pagination control ("Previous page", "Page N"). Load list images lazily after the first four.
  - The closed phone drawer is `inert`. `Layout` starts with a skip link.
- Search omnibox (`src/components/omnibox/`): the bar shows album, own-people (blue), known (violet, "known" marker) and date chips; typed words
  become suggestions through the shared matcher (`src/services/omnibox/matcher.ts`: debounce 150 ms, from 3 characters per span, each word
  matches anywhere inside a name or alias word, case and accent insensitive, no fuzzy matching, longest span wins, a person never used twice,
  at most 3 ambiguous chips per span plus "+N more", an option that replaces the chips with a scrollable list of every match for that span, headed "Matches for <words> (N)"; typing, blur, Escape or a pick closes it, and it uses only the already loaded lists, so no extra request); typing alone never filters; Enter is a plain search, "Ask AI" / Cmd+Enter only where the
  Prompt API exists. "Add both" (shown for two person spans, only if the cap of 5 allows) carries the real count from one `GET /search?limit=1`
  per distinct set of top matches after each 150 ms pause in typing, cached by ids and filters, never per keystroke. Binding rules:
  `onSelection(patch, nextText?)` is ONE URL update per pick (never two in a row), and the trimmed text is written to `q` only when the
  box held the submitted `q` (otherwise only the box is trimmed, so leftover typing is never searched); in AI mode every chip change
  re-runs the whole pipeline (no extra calls per run); while any people or known chip is active the "Hide people photos" switch is not rendered and the
  pipeline gets `hidePeople: false` (the URL value is kept); the AI library-total call receives the same filters as the keyword calls
  (`AiFilters`: album, people, known, from, to, onThisDay) with no extra calls; album is one at a time and album suggestions hide while one is chosen;
  colours come only from `chipStyle.ts` (`OWN_COLOR`, `KNOWN_COLOR`, `ALBUM_COLOR`) and the `--pixdex-ink-*` variables.
- Frontend People filter: Timeline renders `src/components/PeopleFilter.tsx` (Search now uses the omnibox above; one Mantine `MultiSelect`, values `p:<id>` own
  and `k:<id>` known, groups "Your people" then "Known personalities in your photos", own entries blue and known violet with a "known"
  marker so colour is not the only signal; `renderPill` styles picked tags). It loads `['people']` and `['known-people']` itself
  (staleTime 5 minutes, so one extra `GET /people/known` per page load), matches locally with `matchesQuery` over name plus aliases
  (no request per keystroke; typing alone never filters; each typed word matches anywhere inside a name word, so "esh" finds "Ganesh"; from 3 characters only ("m" shows nothing, "man" finds "Rahman"; an empty box lists everyone); a list that has not loaded yet has its ids carried through unchanged), shows when either list is non-empty, caps at 5 combined and drops ids in neither
  list. URL params `people` and `known` are parsed by `src/services/peopleSelection.ts`; changing either resets the page (Search and Timeline).
