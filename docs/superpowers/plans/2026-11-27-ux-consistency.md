# UX Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One look and behaviour for the same action on every page, the accessibility fixes from the review, and one faces request per person page.

**Architecture:** One new read-only Worker route feeds the person page. Everything else is frontend: small shared components (`CoverBadge`, `SetCoverButton`, `BackLink`, `InlineConfirm`, `PageLoading`) and helpers (`copyText`, `usePageTitle`) replace per-page variants.

**Tech Stack:** React 19, Mantine 9, TanStack Query 5, React Router, Hono on Cloudflare Workers with D1, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-27-ux-consistency-design.md`

## Global Constraints

- No migration, no new index, no new dependency.
- Controls are hidden, never disabled, without permission. Person names only through `PERSON_NAME_SQL`.
- No existing action takes more clicks (except Revoke), a viewer gains no control or name, no page makes more requests than today.
- Cover badge: filled `#2563EB`, white text, text "Cover", the same in light and dark.
- Sentence case for labels. No em dashes in any text.
- Work on branch `feat/ux-consistency`. Do not bypass the pre-commit hook. End commit messages with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Run `graphify update .` after code changes. Search modern-web-guidance before writing UI code.

## Review Focus

- An album named `Tom & Jerry's 100% #1?`: back links from the album and its photos return to that album's sort and page (Task 3).
- A photo holding both the cover face and an auto match of the person: badge, no cover button, menu confirms the auto face (Task 2).
- Moving to another page of a person's photos: no tile shows controls made from the previous page's faces (Task 2).
- An empty person page makes no faces request; `photos=` empty or 49 distinct ids is 400, 48 with duplicates is accepted (Tasks 1, 2).
- An open Revoke confirmation followed by a tab switch: nothing stays armed on return (Task 4).

---

### Task 1: Worker route for a person's faces on a page of photos

**Files:**
- Modify: `worker/src/routes/faces.ts`, `worker/src/index.ts`, `functions/api/[[path]].ts`, `dev/mockApi.ts`, `src/services/api/WorkerApiClient.ts`
- Test: create `worker/test/person-faces.test.ts`; modify `worker/test/query-plans.test.ts`, `functions/api/proxy.test.ts`

**Interfaces:**
- Produces: `GET /people/:id/faces?photos=a,b` returning `{ faces: SerializedFace[] }`; `export const MAX_FACE_PHOTOS = 48`; `export const personPhotoFacesSql = (scopeSql: string): string` (binds: 2 name emails, JSON photo ids, person id, scope params); `export async function personFacesRoute(c)`; client `getPersonFaces(personId: string, photoIds: string[]): Promise<SerializedFace[]>`.

- [ ] **Step 1: Write failing Worker tests** (set up rows as `worker/test/review-queue.test.ts` does: `OWNER`, `VIEWER`, `OTHER`, albums `Kanha` owned and shared with VIEWER, `Sundarbans` owned by OTHER and not shared with VIEWER)
  - `returns the person's confirmed and auto faces on the asked photos`: confirmed, auto, unassigned, ignored, another person's face, and a face on an unasked photo; only the first two ids come back, each shaped like `GET /photos/:id/faces`.
  - `leaves out photos the caller cannot see`: VIEWER asking `ph1,ph2` gets only `ph1` faces.
  - `gives a viewer their own label or null, never the owner's name`: `personName` is `null`, then the label after inserting into `person_labels`.
  - `returns nothing for an unknown person or photo`: 200, `{ faces: [] }`.
  - `checks the id list`: missing, empty and 49 distinct ids are 400; 48 distinct ids plus a repeat is 200.
  - `needs a viewer`: read token without `X-Viewer-Email` is 401.
- [ ] **Step 2: Pin the plan** in `query-plans.test.ts`: the plan of `personPhotoFacesSql(scopeFor(U, 'ph.album').sql)` matches `/SEARCH f USING INDEX idx_faces_photo_id/` and not `/idx_faces_person_status_created|SCAN f\b|SCAN ph\b/`.
- [ ] **Step 3: Proxy test** `forwards GET people/:id/faces with the verified email` in `proxy.test.ts`, asserting the upstream URL keeps `?photos=a,b`.
- [ ] **Step 4: Run** `cd worker && npx vitest run test/person-faces.test.ts test/query-plans.test.ts` and `npx vitest run functions/api/proxy.test.ts`. Expected: FAIL (404, missing export).
- [ ] **Step 5: Implement.** The SQL selects the same columns as `FACE_SELECT`:

```sql
... FROM json_each(?) j CROSS JOIN faces f ON f.photo_id = j.value
JOIN photos ph ON ph.id = f.photo_id LEFT JOIN persons p ON p.id = f.person_id
WHERE +f.person_id = ? AND +f.assign_status IN ('confirmed', 'auto') ${scopeSql}
```

  Split `photos` on commas, trim, drop blanks, de-duplicate, then require 1 to 48. Register with `app.get` beside the other `/people` reads. Add `/^people\/[^/]+\/faces$/` to the proxy GET allowlist. Mock: answer from the same dummy faces its `/photos/:id/faces` uses (add auto faces from `autoFacesOf` for the asked photos so the person page shows controls). Add the client method.
- [ ] **Step 6: Run** the same commands plus `cd worker && npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 7: Commit** `feat: read a person's faces for a page of photos in one request`

### Task 2: One cover pattern and one faces request on the person page

**Files:**
- Create: `src/components/CoverBadge.tsx`, `src/components/SetCoverButton.tsx`
- Modify: `src/components/PersonPage.tsx`, `AlbumPhotos.tsx`, `PhotoFaces.tsx`, `PersonLabelEditor.tsx`, `src/services/matchQueue.ts`
- Test: `src/components/__tests__/PersonPage.test.tsx`, `AlbumPhotos.test.tsx`, `PhotoFaces.test.tsx`

**Interfaces:**
- Consumes: `getPersonFaces`.
- Produces: `<CoverBadge />`; `<SetCoverButton label={string} loading={boolean} onClick={() => void} />` (the album page's `ActionIcon`, tooltip "Set as cover", name `Set as cover: <label>`, icon `TbPhotoStar`).

- [ ] **Step 1: Write failing tests** (replace `getPhotoFaces` mocks in `PersonPage.test.tsx` with `getPersonFaces`)
  - `asks for the page's faces once`: three photos give `expect(getPersonFaces).toHaveBeenCalledTimes(1)` with `('pe1', ['p1','p2','p3'])`; `getPhotoFaces` never called.
  - `makes no faces request` for zero photos, and for a person with `canEdit: false`.
  - `sets the largest face as cover from the tile button`: click `Set as cover: A leopard in a tree.`; `setPersonCover('pe1', largestId)`.
  - `shows Cover and no button on the cover photo` (`person.cover.photoId` equals the photo), in `.pdx-tile-badges`.
  - `shows the menu only for an auto match`: no `Photo actions` button for a confirmed-only photo; with auto, menu items are exactly `Confirm Asha`, `Not Asha`.
  - `cover photo with an auto match`: badge, no cover button, `Confirm Asha` sends the auto face id.
  - `drops controls while the next page's faces load`: second `getPersonFaces` never resolves; after "Next page" no `Set as cover` button.
  - `offers Try again when faces fail`: text `Could not load photo actions`, button `Try again` refetches.
  - `reports a failed cover change` as a notification (person and album tests).
- [ ] **Step 2: Run** `npx vitest run src/components/__tests__/PersonPage.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** One `useQuery(['person-faces', id, photoIds])`, enabled when `person?.canEdit` and there are photos, no placeholder data. Replace `usePersonFaces` with a pure `facesOn(faces, photoId)` returning `{ auto, candidate }`; tiles get faces as props. Cover is `person.cover?.photoId === photo.id`. Use `CoverBadge` on the album page, person tiles and photo face rows; give the photo page's "Set as cover" button a `TbPhotoStar` left section. The album page's inline cover error becomes a red notification. Add `'person-faces'` beside every `'photo-faces'` invalidation (`PersonPage`, `PhotoFaces`, `PersonLabelEditor`, and the four lists in `matchQueue.ts`).
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: one cover control and badge, one faces request per person page`

### Task 3: One back link, and the Access tab in the address

**Files:**
- Create: `src/components/BackLink.tsx`
- Modify: `Albums.tsx`, `AlbumCard.tsx`, `AlbumPhotos.tsx`, `PhotoDetail.tsx`, `PersonPage.tsx`, `ReviewAutoFaces.tsx`, `ReviewQueue.tsx`, `AdminAccess.tsx`
- Test: `backLinks.test.tsx`, `AdminAccess.test.tsx`, `ReviewAutoFaces.test.tsx`

**Interfaces:**
- Produces: `<BackLink to={string}>{destination}</BackLink>`, rendering `← {destination}` as an `Anchor` with class `pdx-target`.

- [ ] **Step 1: Write failing tests**
  - `albums keep their place through a photo`: `/albums?sort=name`, open an album, then `/albums/<name>?sort=rating&page=2`, then a photo, history back, and `← All albums` has href `/albums?sort=name`.
  - `photo fallback returns to the album as left`, album name `Tom & Jerry's 100% #1?`: link `← Back to album` href equals the remembered `/albums/<encoded>?sort=rating`.
  - Review grid links are `← Asha` (href `/people/pe1?sort=rating`; `← Unnamed person` when null) and `← To review` (`/review`); To review shows `← All people`.
  - Access: `?status=revoked` opens that tab; choosing Pending removes the parameter.
- [ ] **Step 2: Run** `npx vitest run src/components/__tests__/backLinks.test.tsx src/components/__tests__/AdminAccess.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** with `useRememberAddress` in `Albums` and `AlbumPhotos`, `useLastAddress('/albums')` and `useLastAddress(`/albums/${encodeURIComponent(name)}`)`. Remove the `albumsList` link state. The tab uses `setSearchParams` with `replace: false`; an unknown value is pending. The photo page's history "← Back" and error-state links keep their wording.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: one back link that returns to the list as it was left`

### Task 4: Shared confirm, copy, loading and wording

**Files:**
- Create: `src/components/InlineConfirm.tsx`, `src/components/PageLoading.tsx`, `src/services/copy.ts`
- Modify: `AdminAccess.tsx`, `PersonPage.tsx`, `PhotoDetail.tsx`, `DailySuggestion.tsx`, `Lightbox.tsx`, `Albums.tsx`, `AlbumPhotos.tsx`, `People.tsx`, `ReviewQueue.tsx`, `ReviewAutoFaces.tsx`, `Dashboard.tsx`, `Layout.tsx`
- Test: the matching test files

**Interfaces:**
- Produces: `<InlineConfirm message confirmLabel loading? onConfirm onCancel />` (Cancel focused on mount); `<PageLoading label={string} />` (`role="progressbar"`, `aria-label`); `copyText(text: string): Promise<void>` (notifications "Copied to clipboard" green, "Failed to copy" red with the error message).

- [ ] **Step 1: Write failing tests**
  - Access: `Revoke c@example.com` makes no call, shows `Revoke c@example.com? They are signed out at once.` with focus on `Cancel`; `Confirm revoke` calls `decideAccessRequest(id, 'revoke')`; switching tabs and back shows no confirmation.
  - Person delete keeps its text and `Confirm delete`, focus on `Cancel`.
  - Photo copy shows `Copied to clipboard`; a rejected `writeText` shows `Failed to copy`.
  - `findByRole('progressbar', { name })` with names `Loading albums`, `Loading photos` (album, person), `Loading people`, `Loading matches` (To review, review grid), `Loading requests`.
  - Dashboard shows `-` for both counts while pending.
  - Update the strings: `View original` (photo, Daily, lightbox), `Copy to clipboard`, `Daily pick`, `Today's Instagram pick`, `Suggested caption`, `Suggested hashtags`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL on the new assertions.
- [ ] **Step 3: Implement.** Loading shows only while there is no data and no error. Photo and Daily keep their skeletons; `ListPagination` and the review grid's "Loading pictures…" stay.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: shared confirm, copy and loading patterns, sentence case labels`

### Task 5: Page titles, headings and skip link

**Files:**
- Create: `src/hooks/usePageTitle.ts`
- Modify: every routed page, `AlbumHero.tsx`, `PhotoReview.tsx`, `PhotoFaces.tsx`, `Layout.tsx`, `src/index.css`
- Test: create `src/components/__tests__/pageSemantics.test.tsx`; modify `Layout.test.tsx`

**Interfaces:**
- Produces: `usePageTitle(title?: string): void` setting `document.title` to `<title> | PixdeX`, or `PixdeX`.

- [ ] **Step 1: Write failing tests**: for each route, `expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)`, no heading level more than one below the previous, and `document.title` is `Dashboard`, `Albums`, `<album>`, `Timeline`, `Search`, `People`, `<person as seen>`, `To review`, `Review <name>`, `<photo shortCaption, else filename, else Photo>`, `Daily pick`, `Access requests` (non-admin `Page not found`), each plus ` | PixdeX`. Layout: the first link is `Skip to main content`; clicking it focuses `main` and leaves the address unchanged.
- [ ] **Step 2: Run** those two files. Expected: FAIL.
- [ ] **Step 3: Implement.** Change `order` and keep today's size with `size="h2"` and similar. Hero name is `order={1}`. Search has `<VisuallyHidden><Title order={1}>Search</Title></VisuallyHidden>`. Not-found and error-only states use `Title order={1} fz="md"`. Daily's bold section labels become `Title order={2} fz="md"`. Skip link class `pdx-skip` (off screen until focused), `AppShell.Main id="main" tabIndex={-1}`, `preventDefault` then `focus()`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: page titles, one h1 per page and a skip link`

### Task 6: Pagination names, target sizes, lazy images and phone search bar

**Files:**
- Modify: `ListPagination.tsx`, `People.tsx`, `AlbumCard.tsx`, `Albums.tsx`, `Dashboard.tsx`, `ReviewAutoFaces.tsx`, `PhotoDetail.tsx`, `omnibox/Omnibox.tsx`, `src/index.css`
- Test: `ListPagination.test.tsx`, `Albums.test.tsx`, `Dashboard.test.tsx`, plus any test that finds a page button by its number

**Interfaces:**
- Produces: `AlbumCard` prop `eager?: boolean`; CSS `.pdx-target { display: inline-flex; align-items: center; min-height: 24px; }`.

- [ ] **Step 1: Write failing tests**: buttons named `Previous page`, `Next page`, `Page 2`; album and Dashboard images 1 to 4 have no `loading="lazy"`, the 5th has it.
- [ ] **Step 2: Run** those files. Expected: FAIL.
- [ ] **Step 3: Implement.** `Pagination` `getControlProps` and `getItemProps`. Ignore face `ActionIcon size={24}`; album Share `size="compact-sm"`; `pdx-target` on "Open photo", "View original", the photo page's album and map links. Omnibox: the bar row wraps, the input is `flex: 1 1 240px`, the two buttons share one non-wrapping group.
- [ ] **Step 4: Run** `npm test && npm run lint && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `fix: named pagination, 24px targets, lazy images and the phone search bar`

### Task 7: Browser check, measurement and docs

**Files:**
- Modify: `README.md`, `AGENTS.md`, `docs/architecture.md`, `docs/development.md`

- [ ] **Step 1:** `PIXDEX_MOCK=1 npm run dev`; at 1280px and 390px, light and dark, visit every route. Expected: no horizontal overflow, one `h1`, both search buttons fully labelled, no listed target under 24px, person page makes one `/people/<id>/faces` request, back links keep sort and page.
- [ ] **Step 2:** Measure rows read for the new route with 48 photos on a local D1 (`meta.rows_read`), beside the sum for the 48 old requests; record both in `docs/development.md` with the `wrangler tail` and `wrangler d1 insights` follow-up.
- [ ] **Step 3:** Document the route, the shared components and patterns (replace the `AGENTS.md` text on albums link state, the person photo menu and the old back link names).
- [ ] **Step 4:** `npm test && npm run lint && npm run build`, `cd worker && npm test && npm run typecheck`, `graphify update .`. Expected: PASS.
- [ ] **Step 5: Commit** `docs: UX consistency patterns and the person faces read`
