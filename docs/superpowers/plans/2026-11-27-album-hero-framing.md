# Album Hero Framing and Browser Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep each album's cover original in the browser instead of R2, and let the owner move and zoom it inside the banner.

**Architecture:** IndexedDB holds one record per album; the page fetches `/api/originals/:coverId` when the record is missing, stale or `unavailable`. Framing is a nullable JSON column on `albums`, written by a new owner-only route and returned by `GET /albums`. The `/heroes` routes are removed.

**Tech Stack:** Hono Worker, D1, Pages Function, React 19, Mantine, TanStack Query, IndexedDB, Vitest (`fake-indexeddb` as a new dev dependency).

**Spec:** `docs/superpowers/specs/2026-11-27-album-hero-framing-design.md`

## Global Constraints

- No header images in R2. Originals are never stored on Cloudflare. The browser stores the file exactly as served.
- IndexedDB database `pixdex`, store `heroes`, key album name; record `{ album, contentHash, status: 'ready' | 'unavailable' | 'undecodable', image?: Blob, updatedAt }`.
- `unavailable` (network error, non-OK status, non-`image/*` content type) is retried on every album page visit, with no back-off; `undecodable` is not retried until the cover changes.
- Errors from fetching or storing are never shown. Storage failure still shows the fetched image.
- Framing `{ x, y, zoom }`: x, y 0 to 100, zoom 1 to 3; rendered with `object-position`, `transform-origin` and `scale`. Arrow keys 1% (10% with Shift), `+`/`-` zoom, buttons "Reposition", "Save", "Cancel", "Reset". Owner only.
- Migration `0021` is additive: nullable `albums.cover_framing` JSON `{ hash, x, y, zoom }`, applied only while `hash` is the current cover.
- Performance: stored hero makes no request; `GET /albums` one more column; save is one primary-key read and one row written.
- Worker zod is `zod/mini`. No em dashes. Do not bypass the pre-commit hook.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

- Cover changes while the owner is editing: edit mode closes and nothing is saved against the new cover (Task 3).
- A sign-in or error page served with 200: recorded `unavailable` and retried, never `undecodable` (Task 2).
- IndexedDB blocked or full: the fetched image still shows, no error (Task 2).
- One finger lifted at the end of a pinch: the picture does not jump (Task 3).
- A new photo indexed into a framed album: the framing survives the album triggers (Task 1).

---

### Task 1: Save and return framing (Worker and proxy)

**Files:**
- Create: `worker/migrations/0021_album_framing.sql`, `worker/src/db/framing.ts`, `worker/src/routes/framing.ts`, `worker/test/framing.test.ts`
- Modify: `worker/migrations/index.ts`, `worker/src/index.ts`, `worker/src/routes/photos.ts` (`getAlbumsRoute`), `functions/api/[[path]].ts`, `functions/api/proxy.test.ts`

**Interfaces:**
- Produces: `PUT /albums/framing` body `{ album: string, contentHash: string, x: number, y: number, zoom: number }` returning `{ album, coverFraming: { x, y, zoom } | null }`; `coverFraming` of the same shape on each album of the paged `GET /albums`; `parseFraming(raw: string | null, contentHash: string | null): { x, y, zoom } | null`.

- [ ] **Step 1: Write the failing tests** in `worker/test/framing.test.ts` (seed albums and sharing as in `sharing-writes.test.ts`):
  - owner saves `{x:20,y:70,zoom:1.5}`: 200, and `GET /albums?limit=1&name=<album>` returns it for owner and viewer; an unframed album returns `coverFraming: null`.
  - viewer 403, stranger 404, column unchanged.
  - 400 for x `-1` and `101`, zoom `0.9` and `3.1`, missing field.
  - 409 for a `contentHash` that is not the cover's, column unchanged.
  - `{x:50,y:50,zoom:1}` stores NULL.
  - changing the cover (`PUT /albums/cover`) returns null; changing back returns the framing.
  - inserting another photo into the album keeps the column.
  - invalid JSON in the column returns null.

  In `proxy.test.ts`: `PUT /api/albums/framing` with JSON is forwarded to `/albums/framing` with the verified email.
- [ ] **Step 2: Run** `cd worker && npx vitest run test/framing.test.ts` and `npx vitest run functions/api/proxy.test.ts` from the root. Expected: FAIL.
- [ ] **Step 3: Implement.** SQL: `ALTER TABLE albums ADD COLUMN cover_framing TEXT;` (mirrored in `migrations/index.ts` the way `0016` is). `putAlbumFramingRoute` uses `albumRole` (404, 403), then `UPDATE albums SET cover_framing = ? WHERE name = ? AND content_hash = ?`; zero changes is 409. Register `app.use('/albums/framing', requireReadToken)` and `guardedWrite('PUT', '/albums/framing', ...)`. Add `/^albums\/framing$/` to `WRITE_PATHS.PUT`.
- [ ] **Step 4: Run** `cd worker && npm test && npm run typecheck`, then `npm test` at the root. Expected: PASS.
- [ ] **Step 5: Commit** `feat(worker): save the album cover framing`.

### Task 2: Browser store and loader

**Files:**
- Create: `src/services/heroStore.ts`, `src/services/__tests__/heroStore.test.ts`
- Rewrite: `src/services/heroImage.ts`, `src/services/__tests__/heroImage.test.ts`
- Modify: `package.json`, `package-lock.json` (`npm i -D fake-indexeddb`), `src/components/AlbumHero.tsx` and its test (call the new loader)

**Interfaces:**
- Produces:
  - `type HeroRecord = { album: string; contentHash: string; status: 'ready' | 'unavailable' | 'undecodable'; image?: Blob; updatedAt: number }`
  - `readHero(album: string): Promise<HeroRecord | null>`, `writeHero(record: HeroRecord): Promise<void>` (neither rejects)
  - `heroHash(url)` unchanged; `loadHero(album: string, contentHash: string, photoId: string): Promise<Blob | null>` (never rejects)

- [ ] **Step 1: Write the failing tests.**
  - `heroStore` (with `fake-indexeddb`): write then read returns the record; a second write for the album replaces it; unknown album is null; with `indexedDB` undefined, or `open`/`put` failing (including quota), read is null and write resolves.
  - `loadHero` (stub `fetch` and image decoding): ready record for this hash returns the blob with no fetch; `unavailable` record fetches again and, on success, stores `ready`; `undecodable` record returns null with no fetch; another hash's record fetches and is overwritten.
  - stored image is the same bytes as the response.
  - fetch rejects, 502, `text/html` 200, and body read failure each store `unavailable` and return null.
  - `image/heic` that fails to decode stores `undecodable`.
  - `writeHero` doing nothing still returns the blob.
  - two concurrent calls make one fetch; a call after they settle with `unavailable` fetches again.
- [ ] **Step 2: Run** `npx vitest run src/services`. Expected: FAIL.
- [ ] **Step 3: Implement.** Decode check with `new Image()` on an object URL and `img.decode()` (matches what will be displayed), revoking the URL. In-flight calls shared in a `Map` keyed by album and hash, removed on settle. Remove `fitWithin`, `resizeToJpeg` and the upload. In `AlbumHero`: `queryKey ['album-hero', name, hash]`, `gcTime: 0`, `staleTime: Infinity`, `retry: false`; show the blob through an object URL, revoked when it changes or unmounts; drop the `canCreate` prop (viewers load too). Component tests: unmount and remount calls `loadHero` again; the object URL is revoked.
- [ ] **Step 4: Run** `npm test && npm run lint && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): keep the album cover original in the browser`.

### Task 3: Reposition and zoom

**Files:**
- Create: `src/services/framing.ts`, `src/services/__tests__/framing.test.ts`
- Modify: `src/components/AlbumHero.tsx` and its test (a separate editor component is fine), `src/components/AlbumPhotos.tsx` and its test, `src/services/api/WorkerApiClient.ts`, `src/types/api.ts`, `src/index.css`, `dev/mockApi.ts`

**Interfaces:**
- Consumes: Task 1 route and `coverFraming`.
- Produces: `type Framing = { x: number; y: number; zoom: number }`; `DEFAULT_FRAMING = { x: 50, y: 50, zoom: 1 }`; `clampFraming(f): Framing`; `frameStyle(f): CSSProperties`; `dragFraming(start: Framing, dx: number, dy: number, natural: Size, box: Size): Framing`; `AlbumSummary.coverFraming?: Framing | null`; `workerApiClient.setAlbumFraming(album, contentHash, framing): Promise<void>`; `AlbumHero({ name, photoCount, coverPhotoId, coverThumbnailUrl, framing, canEdit })`.

- [ ] **Step 1: Write the failing tests.**
  - `dragFraming`, natural 3000x2000, box 1200x300: from centre, `dy = 50` at zoom 1 gives y 40, x 50; `dx = -120` at zoom 2 gives x 60; results clamp to 0 and 100.
  - `frameStyle({x:20,y:70,zoom:1.5})` is `{ objectPosition: '20% 70%', transformOrigin: '20% 70%', transform: 'scale(1.5)' }`.
  - component: saved framing styles the sharp image and positions the blurred one; "Reposition" only when `canEdit` and the sharp image shows; edit mode hides the title; ArrowRight is x+1, Shift+ArrowDown y+10, `+` raises zoom, never past 1 to 3; Reset gives the default; Cancel restores; Save calls `setAlbumFraming(album, hash, framing)` and leaves edit mode after the summary refreshes; a failed save stays in edit mode with the error text; a new cover hash closes edit mode without saving; pointer drag moves; two pointers pinch zoom, and lifting one does not jump.
- [ ] **Step 2: Run** `npx vitest run src`. Expected: FAIL.
- [ ] **Step 3: Implement.** `overflow = rendered size * zoom - box` per axis (rendered by the cover scale `max(box.w / natural.w, box.h / natural.h)`); percent change is `-delta / overflow * 100`, unchanged when overflow is under 0.5px. The blurred image uses the same position with `scale(zoom * 1.1)`. `touch-action: none` on the drag surface in edit mode only; zoom control is a Mantine `Slider` labelled "Zoom", step 0.05. `+`/`-` step 0.1. The dev mock returns `coverFraming` and accepts `PUT /albums/framing` in memory.
- [ ] **Step 4: Run** `npm test && npm run lint && npm run build`. Expected: PASS.
- [ ] **Step 5: Check in a browser** with `PIXDEX_MOCK=1 npm run dev`: desktop and 390px touch, light and dark; drag, zoom, save, reload; confirm the IndexedDB record and that a reload makes no originals request.
- [ ] **Step 6: Commit** `feat(ui): reposition and zoom the album cover`.

### Task 4: Remove the R2 hero path and update docs

**Files:**
- Delete: `worker/src/routes/heroes.ts`, `worker/test/heroes.test.ts`
- Modify: `worker/src/index.ts`, `functions/api/[[path]].ts`, `functions/api/proxy.test.ts`, `dev/mockApi.ts`, `README.md`, `AGENTS.md`, `docs/architecture.md`, `docs/development.md`

- [ ] **Step 1: Change the proxy tests:** replace `describe('album heroes')` with: GET and PUT `/api/heroes/<64 a>` are 404 with no upstream call; PUT with `image/jpeg` on `/api/albums/framing` is 415. Run them. Expected: FAIL.
- [ ] **Step 2: Remove** the routes, `HERO_PATH`, its cache rule, the binary PUT branch and the mock's hero path. `grep -rn "heroes/\|HERO_PATH" src worker/src functions dev` shows only the IndexedDB store name.
- [ ] **Step 3: Docs.** Describe browser storage, retry rules, framing route and performance; add `cover_framing` and `PUT /albums/framing` to the AGENTS.md exception for owner-edited `albums` columns; say originals are now cached in viewers' browsers; in `docs/development.md` add the after-deploy step: delete the `hero/` objects from the `pixdex-thumbnails` bucket.
- [ ] **Step 4: Run** `npm test && npm run lint && npm run build && (cd worker && npm test && npm run typecheck)` and `graphify update .`. Expected: all pass.
- [ ] **Step 5: Commit** `refactor: remove the stored album hero routes`.
