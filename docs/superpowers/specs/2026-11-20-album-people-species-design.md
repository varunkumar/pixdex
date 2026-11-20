# Album page: people and species tabs - design

Date: 2026-11-20. Status: awaiting approval.

## Intent

Someone opening an album wants to see who and what is in it, and jump to those photos. Today the album page is
only a paged photo grid. People (faces) and animal species (BioCLIP) are already indexed per photo but cannot
be browsed per album. Add a People tab and a Species tab to the album page, each a gallery of tiles; clicking a
tile filters the album's photos.

## Goals

- Album page gets tabs: Photos | People (n) | Species (n). Chosen by the user from mockups (option C).
- People tab: round face-crop tiles for your own people (blue) and known personalities (violet, "known" marker),
  each with the count of photos in this album.
- Species tab: square tiles (best-scoring photo of that species in this album), common name, count.
- Clicking a tile switches to the Photos tab, filtered inside the album, with a removable chip and the filtered count.
- Works on desktop and phone (2 columns on phone, 6 on desktop for species, tabs fit both).
- Tabs and lists are hidden when empty (no people, no species scan yet).

## Non-goals

- No multi-select of tiles (one filter at a time in v1).
- No library-wide species browsing or a species page (the filter exists on `/search`, the UI does not).
- No editing species names or tiles; no naming faces from the tile gallery.
- No change to indexing, the agent, or the face and species models.

## Anti-goals

- A tile must never reveal a person name the caller may not see (names are private to their owner).
- No album page load may get noticeably slower: the lists load after the photo grid and only once per 5 minutes.
- Nothing here may widen what a viewer can see: every query stays scoped by `scopeFor`.

## Constraints (from AGENTS.md)

- Frontend only calls same-origin `/api/*`; any new Worker route read by the browser must be added to the Pages Function allowlist (`functions/api/`).
- Worker: zod via `zod/mini`; no new CPU-heavy loops; emails lowercase; names only through `PERSON_NAME_SQL`; never select `p.name` raw.
- DB: no migration is needed (additive only if one turns up).
- Performance review is mandatory and stated below. After the change update README.md, AGENTS.md and docs/.

## Approaches considered

1. **Live per-album aggregates (chosen).** One new endpoint, computed on request with `json_each` and the `faces` indexes. No migration, no backfill, no write cost. Read cost scales with the album's size.
2. A `photo_species` table with an index. Indexed everywhere and reusable library-wide, but needs a migration, a backfill, extra writes at ingest and sync on rescan or album move. Held back as a later upgrade if big albums prove slow; the UI and the endpoint shape would not change.
3. A cached summary on `albums`. Cheapest reads, but `albums` is trigger-derived and the summary would go stale on face edits. Rejected.

## Design

### Worker

**`GET /albums/contents?name=<album>`** (READ_TOKEN plus `X-Viewer-Email`, like the other reads). Returns
`{ people: PersonTile[], known: KnownTile[], species: SpeciesTile[] }`, each list capped at 200, sorted by count
descending then name.

- Scope: `scopeFor(user, 'photos.album')` on the album's photos. Unknown or invisible album gives 404 (same as other album reads), empty album gives empty lists.
- `PersonTile`: `{ id, name | null, canEdit, photoCount, cover: SerializedFace | null }`. Counts distinct photos with a confirmed or auto face. Name via `PERSON_NAME_SQL` (the caller's own label or null for people they do not own; the UI shows "Unnamed" for null, as the People page does). Cover: the person's chosen cover face if it is in this album, else the best face in this album.
- `KnownTile`: `{ id, name, photoCount, cover }`, from `faces.known_id` (a "looks like" suggestion, same as everywhere; independent of `person_id`, so a face can feed both a person tile and a known tile). Cover is the highest `known_score` face in the album.
- `SpeciesTile`: `{ scientific, common, photoCount, coverPhotoId, thumbnailUrl }`, grouped by scientific name from `json_each(photos.species)`; the cover is the photo with the highest score for that species. `species_model IS NULL` photos contribute nothing.
- Statements run in one `DB.batch`: people, known, species. Each is a single set-based statement; no N+1.

**`species=<scientific>` on `GET /search`**, combined with `album` (and `people`, `known`, dates). One bound parameter, added as
`AND EXISTS (SELECT 1 FROM json_each(photos.species) WHERE json_extract(value,'$.scientific') = ?)` after the album and scope filters, so the scan is limited to the album's rows. One species at a time. Also accepted on `/timeline` is out of scope.

**Pages Function**: allowlist `GET albums/contents`; `species` query param passes through on search like the others.

### Frontend (`src/components/AlbumPhotos.tsx`)

- New React Query `['album-contents', name]`, `staleTime` 5 minutes, enabled after the photos query has settled.
- Tabs via Mantine `Tabs`, state in the URL: `?tab=people|species` (absent means photos). Photos tab filter in the URL: `people=<id>`, `known=<Q-id>`, `species=<scientific>` (one of them at a time). Changing a filter resets the page.
- Tiles: People use `FaceTile`-style round crops (blue ring for own, violet for known with a "known" label); Species use the photo thumbnail. Colours only via `chipStyle.ts` (add `SPECIES_COLOR = 'green'` and an ink variable in `index.css`). Counts under the name.
- Filter chip above the grid (`[Asha ✕]`), plus the filtered count. For a person the chip has a "View all photos of Asha" link to the person page.
- Mobile: tabs in the page body, 2-column tile grid; desktop 6 columns for species and people.
- Empty lists hide their tab. Loading shows tab skeletons, an error shows a one-line message and leaves the Photos tab working.
- `dev/mockApi.ts` gets the new route and the `species` filter so `PIXDEX_MOCK=1 npm run dev` shows it.

## Performance review (CPU and D1)

- Worker CPU: JSON work (`json_each`) runs inside D1, not the Worker; the Worker only maps at most 600 small rows. No embedding loop, no large JSON parse.
- D1 per `GET /albums/contents`: rows read are about the album's photo count (species column, found by `idx_photos_album`) plus the faces of those photos (via `idx_faces_photo_id`) plus one `person_labels` lookup per not-owned person; 0 written. Scoped and bounded by album size, no OFFSET, no COUNT(*) on every request, no N+1.
- `species=` filter on `/search`: the album's rows are read once (same as today's album page) plus a `json_each` per row; the COUNT query repeats it. UNMEASURED locally.
- Added cost on the album page: one extra request per 5 minutes per viewer, after the grid. A 5,000-photo album reads about 5,000 or more rows per load; that is the price of approach 1. Measure with `wrangler tail` and `wrangler d1 insights` on a large real album, and run `EXPLAIN QUERY PLAN` on the three statements; if it hurts, move to approach 2.

## Minor calls (made by the designer, not discussed)

- "Best face" for a person tile: the person's chosen cover face if it is in this album, else the highest `det_score` confirmed face, else the highest `det_score` auto face.
- Deep link before `['album-contents']` has loaded: the chip shows the scientific name (or "Person") until the list arrives, then the common name.
- More than one of `people`, `known`, `species` in the URL: keep the first in that order and drop the rest.

## Left to the builder

- Exact SQL, query shapes and the `EXPLAIN QUERY PLAN` check.
- Tile visual polish, skeleton and empty-state wording, "Unnamed" label handling.
- Test plan: Worker tests for scope (viewer, owner, stranger 404), name privacy, 200 cap, species grouping; frontend tests for tabs, URL state, mobile and chip behaviour.
- Updating README.md, AGENTS.md, docs/ in the same commit.
