# Album Hero Cover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the album cover as a sharp hero banner on the album page, from a 2048px copy made once by the owner's browser and stored in R2.

**Architecture:** Two Worker routes (`GET` and `PUT /heroes/:contentHash`) over the existing R2 bucket, proxied by the Pages Function. The browser asks for the hero; on 404, an owner's browser resizes the original on a canvas and uploads it. A blurred thumbnail sits underneath until the hero loads.

**Tech Stack:** Hono Worker, R2, D1, Pages Function, React 19, Mantine, TanStack Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-27-album-hero-cover-design.md`

## Global Constraints

- R2 key `hero/<contentHash>.jpg` in the `THUMBNAILS` bucket; content hash pattern `^[A-Za-z0-9_-]{16,64}$`.
- Long side 2048px, never enlarged, EXIF orientation applied, JPEG quality 0.85, lowered if over 2 MB (2 * 1024 * 1024 bytes).
- Written once: an existing object is never overwritten.
- Hero height 340px, 220px below 576px width; photo cropped to fill, centred.
- Failure is silent (blurred thumbnail stays) and not retried in the same page session.
- Full originals are never stored in R2. No D1 migration, no agent change, no image processing in the Worker.
- No em dashes in any text. Do not bypass the pre-commit hook.
- Performance: view = 1 D1 read + 1 R2 get; creation = existing original access check + 1 D1 read + 1 conditional R2 put.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

- Cover changed while the page is open: the new cover shows, never the old cover's hero (Task 4).
- Original unreachable (502, machine off): blurred thumbnail, no upload, no error text (Task 3).
- Format the browser cannot decode (HEIC): same as above (Task 3).
- Image still over 2 MB at the lowest quality: nothing is uploaded (Task 3).
- Upload refused or network lost: blurred thumbnail, no error text (Task 3).

---

### Task 1: Worker hero routes

**Files:**
- Create: `worker/src/routes/heroes.ts`, `worker/test/heroes.test.ts`
- Modify: `worker/src/index.ts`

**Interfaces:**
- Produces: `GET /heroes/:contentHash` (200 JPEG, 404) and `PUT /heroes/:contentHash` (201 created, 200 already there, 400, 403, 404, 413). Both need READ_TOKEN and `X-Viewer-Email`.

- [ ] **Step 1: Write the failing tests** in `worker/test/heroes.test.ts`. Setup: delete from `photos`, insert one photo with hash `0123456789abcdef0123456789abcdef` in album `Heroes` (as in `ingest-thumbnail.test.ts`), set `shared_with = '["viewer@example.com"]'`, delete the R2 object `hero/<hash>.jpg`. `JPEG = new Uint8Array([0xff, 0xd8, 0xff, 1, 2])`, `put(hash, body, as)` sends `Content-Type: image/jpeg` with `readHeaders(as)`.
  - `stores once and serves it`: GET is 404; owner PUT is 201; GET is 200 with bytes equal to `JPEG`, `Content-Type: image/jpeg`, `Cache-Control: private, max-age=31536000, immutable`; viewer GET is 200.
  - `never overwrites`: second PUT with different JPEG bytes is 200 and GET still returns the first bytes.
  - `viewer 403, stranger 404, nothing stored`: statuses as named; `env.THUMBNAILS.head(key)` is null.
  - `stranger cannot read a stored hero`: after owner PUT, stranger GET is 404.
  - `404 for a hash with no photo`: PUT with `'f'.repeat(32)` is 404.
  - `rejects bad input`: hash `short` is 400; body `[1,2,3,4]` is 400; `2 * 1024 * 1024 + 1` bytes starting with the JPEG magic is 413; nothing stored.
- [ ] **Step 2: Run** `cd worker && npx vitest run test/heroes.test.ts`. Expected: FAIL (404 where 201 is expected).
- [ ] **Step 3: Implement** `getHeroRoute(c)` and `putHeroRoute(c)` in `worker/src/routes/heroes.ts`.
  - Both: validate the hash (400), then one query `SELECT va.owner_email AS owner FROM photos p ${join} WHERE p.content_hash = ? ${where}` using `photoAccess(userOf(c), 'p')`; no row is 404.
  - PUT: owner mismatch is 403; check `content-length` and then actual size against 2 MB (413); first three bytes must be `FF D8 FF` (400); `THUMBNAILS.put(key, bytes, { httpMetadata: { contentType: 'image/jpeg' }, onlyIf: new Headers({ 'If-None-Match': '*' }) })`; a `null` result is 200, otherwise 201.
  - In `index.ts`: `app.use('/heroes/*', requireReadToken)`, `app.get(...)`, `guardedWrite('PUT', '/heroes/:contentHash', putHeroRoute)`.
- [ ] **Step 4: Run** `cd worker && npm test && npm run typecheck`. Expected: all pass, including `sharing-writes.test.ts`. If `never overwrites` fails because the local R2 ignores the wildcard, use `onlyIf: { etagDoesNotMatch: '*' }`, and failing that a `head` before the `put` (state this in the summary).
- [ ] **Step 5: Commit** `feat(worker): store and serve album hero images`.

### Task 2: Pages Function proxy

**Files:**
- Modify: `functions/api/[[path]].ts`, `functions/api/proxy.test.ts`

**Interfaces:**
- Consumes: Task 1 routes.
- Produces: same-origin `GET` and `PUT /api/heroes/:contentHash`.

- [ ] **Step 1: Write the failing tests**, a `describe('album heroes')` in `proxy.test.ts` with `HASH = 'a'.repeat(32)`:
  - `GET is proxied and cached for a year`: upstream URL `https://worker.example.dev/heroes/<HASH>`, response `Cache-Control` `private, max-age=31536000, immutable`.
  - `a missing hero is not cached`: upstream 404 gives `no-store`.
  - `PUT forwards the bytes unchanged`: send `new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x80])` as `image/jpeg`; the upstream body bytes are equal, `content-type` is `image/jpeg`, `x-viewer-email` is the verified email, response is `no-store`.
  - `PUT needs image/jpeg`: `application/json` gives 415 and no upstream call.
  - `image/jpeg is refused on other writes`: PUT `/api/albums/cover` with `image/jpeg` gives 415.
  - `a malformed hash is 404`: PUT and GET `/api/heroes/a/b` give 404, no upstream call.
- [ ] **Step 2: Run** `npx vitest run functions/api/proxy.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `const HERO_PATH = /^heroes\/[A-Za-z0-9_-]{16,64}$/;` in `ALLOWED_PATHS`, in `cacheControlFor` beside thumbnails, and in `WRITE_PATHS.PUT`. In `forwardWrite`, a PUT to `HERO_PATH` requires `image/jpeg` and forwards `await request.arrayBuffer()`; every other write keeps the JSON rule and `request.text()`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(functions): proxy album hero images`.

### Task 3: Browser service

**Files:**
- Create: `src/services/heroImage.ts`, `src/services/__tests__/heroImage.test.ts`

**Interfaces:**
- Consumes: Task 2 paths; `/api/originals/:photoId`.
- Produces:
  - `heroHash(coverThumbnailUrl: string | null | undefined): string | null` (the part after `/thumbnails/`)
  - `fitWithin(width: number, height: number, max: number): { width: number; height: number }`
  - `resizeToJpeg(original: Blob): Promise<Blob>` (throws when it cannot)
  - `loadHero(contentHash: string, photoId: string, canCreate: boolean): Promise<string | null>` (the `/api/heroes/<hash>` URL, or null; never rejects)

- [ ] **Step 1: Write the failing tests.** Stub `fetch`, `createImageBitmap`, `HTMLCanvasElement.prototype.getContext` and `.toBlob`.
  - `heroHash`: `'/thumbnails/abc'` gives `'abc'`; null gives null.
  - `fitWithin(6000, 4000, 2048)` is `{ width: 2048, height: 1365 }`; `(3000, 6000, 2048)` is `{ width: 1024, height: 2048 }`; `(800, 600, 2048)` is unchanged.
  - `resizeToJpeg` calls `createImageBitmap` with `{ imageOrientation: 'from-image' }`, draws at the fitted size, first quality 0.85; when the first blob is over 2 MB it retries lower and returns the first that fits; it closes the bitmap; it throws when none fits.
  - `loadHero` existing: GET 200 returns the URL; no other request.
  - `loadHero` viewer: 404 with `canCreate` false returns null; one request.
  - `loadHero` creates: 404, then GET `/api/originals/ph1` 200, then PUT `/api/heroes/<hash>` with `Content-Type: image/jpeg` and the resized blob; 201 and 200 both return the URL.
  - Each returns null with no PUT: hero GET 500; hero GET rejects; original 502; `createImageBitmap` rejects; no size fits.
  - PUT 403 returns null; PUT rejects returns null.
- [ ] **Step 2: Run** `npx vitest run src/services/__tests__/heroImage.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** Qualities `[0.85, 0.75, 0.65, 0.5]`, `imageSmoothingQuality = 'high'`. Consume the 200 response body (`await res.blob()`) so the browser cache serves the following `<img>`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): create album hero images in the browser`.

### Task 4: Hero banner, dev mock and docs

**Files:**
- Create: `src/components/AlbumHero.tsx`, `src/components/__tests__/AlbumHero.test.tsx`
- Modify: `src/components/AlbumPhotos.tsx`, `src/components/__tests__/AlbumPhotos.test.tsx`, `src/index.css`, `dev/mockApi.ts`, `README.md`, `AGENTS.md`, `docs/architecture.md`

**Interfaces:**
- Consumes: `heroHash`, `loadHero`; `AlbumSummary` (`coverPhotoId`, `coverThumbnailUrl`, `photoCount`, `role`).
- Produces: `AlbumHero({ name: string; photoCount: number; coverPhotoId: string; coverThumbnailUrl: string; canCreate: boolean })`.

- [ ] **Step 1: Write the failing tests.** In `AlbumHero.test.tsx` (mock `../../services/heroImage` keeping the real `heroHash`):
  - blurred image `src` is `/api/thumbnails/<hash>` while `loadHero` is pending; heading `Kanha` and `128 photos` show (`1 photo` for one).
  - resolved URL renders `img` with name `Cover photo of Kanha`; null renders none and no error text.
  - `loadHero` is called with `(hash, coverPhotoId, canCreate)`, once, also after a rerender.
  - rerender with a new hash never shows the old URL and calls `loadHero` for the new one.

  In `AlbumPhotos.test.tsx`: with a cover URL there is exactly one `Kanha` heading, inside the hero, showing the summary's `photoCount`; `canCreate` is true for owner, false for viewer; with a filter active the row still shows the filtered total; with `coverThumbnailUrl: null` the old header stays and `loadHero` is not called.
- [ ] **Step 2: Run** `npx vitest run src/components/__tests__/AlbumHero.test.tsx src/components/__tests__/AlbumPhotos.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** `useQuery({ queryKey: ['album-hero', hash], queryFn: () => loadHero(...), staleTime: Infinity, gcTime: Infinity, retry: false })`. Classes `pdx-hero`, `pdx-hero-blur`, `pdx-hero-img` (both `object-fit: cover`), `pdx-hero-text` (bottom left, white, dark gradient, name clamped to 2 lines). In `AlbumPhotos`, render the hero under "All albums" when `summary.coverThumbnailUrl` is set; then drop the title from the row and show the row's count only while a filter is active. Dev mock: `GET /heroes/<hash>` serves the generated landscape of that photo at large size.
- [ ] **Step 4: Run** `npm test && npm run lint && npm run build`. Expected: all pass.
- [ ] **Step 5: Check in a browser** with `PIXDEX_MOCK=1 npm run dev`: album page at desktop and 390px, light and dark. Then run `resizeToJpeg` in the page on a canvas-made 6000x4000 PNG and confirm a JPEG blob of 2048x1365.
- [ ] **Step 6: Docs.** `AGENTS.md` (intro line, a hero bullet with routes and performance numbers, the proxy list), `README.md` (both "originals stay local" statements gain: a 2048px copy of each album cover is stored in R2), `docs/architecture.md` (storage line, R2 line, routes). Run `graphify update .`.
- [ ] **Step 7: Commit** `feat(ui): show the album cover as a hero banner`.
