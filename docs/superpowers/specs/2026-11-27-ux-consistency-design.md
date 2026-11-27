# UX consistency, accessibility and person page reads: design

Date: 2026-11-27. Status: approved.

## Intent

The same action should look and behave the same on every page. Fix what a review of all pages found (mock data,
1280px and 390px, checked against Google Chrome's modern web guidance), and stop the person page making one faces
request per photo.

Written against main at 395418c (PR #68), which already keeps people list, person page, unnamed groups and review
grid state across Back.

## Goals

One cover pattern, one back link pattern, one confirm, copy and loading pattern, the accessibility fixes below, and
one faces request per person page.

## Non-goals and anti-goals

- Not included: restoring scroll position on in-page back links, moving focus on route change, retry buttons on every
  error, colour contrast changes (not measured), route code splitting, any change to matching or the agent.
- A failure would be: an existing action taking more clicks (except Revoke), a viewer gaining a control or a name,
  or any page making more requests than today.

## Constraints

No migration, no new index. Controls stay hidden (never disabled) without permission. Person names only through
`PERSON_NAME_SQL`. No new dependency.

## Approaches

Cover control (A chosen):

- **A. Same star-photo icon on album and person tiles (chosen).** One click; some person tiles get two buttons.
- B. A menu on both. Tidier, but albums need two clicks for their only action.
- C. All icons, no menus. Crowded on phones, and a bare cross does not say "Not <name>".

Person page faces (1 chosen):

- **1. One batch read (chosen).** One new route.
- 2. Faces inside `/search`. No extra request, but person work in a busy route and a whole page refetch per change.
- Loading on hover or tap was rejected: the badge, mark and buttons need the data when the page shows.

## Design

### 1. Cover

- One "Cover" badge everywhere: filled blue `#2563EB`, the middle colour of the header gradient, with white text
  (about 5:1), the same in light and dark. It replaces the yellow album badge and the teal photo page badge.
- Person tiles, only for a person the user owns (`canEdit`): that badge on the photo where
  `person.cover.photoId` matches; otherwise an icon button `TbPhotoStar`, "Set as cover: <caption>", with the album
  page's tooltip and loading state. It sets the person's largest face in that photo, as today.
- The `⋮` menu appears only when the photo has an auto match for this person, with "Confirm <name>" (needs
  `canEdit` on the photo too) and "Not <name>". "Set as cover" and "Current cover" leave the menu.
- Photo page face rows keep a text button (a list, not a tile) with the same icon, and the same blue badge.
- A failed cover change shows a red notification on both album and person pages.

### 2. Back links

- One `BackLink` component, always "← <destination>": "All albums", "All people" (also on To review, replacing
  "Back to People"), the person's name on the review grid (replacing "Back to the person"; "Unnamed person" if none),
  and "To review" (replacing "All to review").
- Albums use `useRememberAddress` / `useLastAddress` like People, replacing the `location.state.albumsList` handoff,
  so the sort and page also survive going through a photo. The album page records its own address, used by the photo
  page's "← Back to album" fallback. The photo page's history "← Back" is unchanged.
- The Access page tab moves into the address (`?status=`, absent for pending).

### 3. Confirm, copy, loading, wording

- Revoke asks first, with the inline confirm used for deleting a person, made one shared component: it says the person
  is signed out at once, focus starts on Cancel. Approve and Deny stay one click (both reversible by Approve).
- One copy helper with the "Copied to clipboard" / "Failed to copy" notification, used on photo and Daily pick.
- One `PageLoading` (spinner with an accessible name) on Albums, album, People, person, To review, the review grid
  and Access. Photo and Daily pick keep their content-shaped skeletons. Dashboard counts show a dash until loaded.
- Sentence case: "View original" (also replaces "Open original"), "Copy to clipboard", "Daily pick",
  "Today's Instagram pick", "Suggested caption", "Suggested hashtags".

### 4. Accessibility and images

- Search at 390px: the Ask AI and Add keywords buttons wrap below the search box with full labels.
- Page titles "<page> | PixdeX" through one hook: section name, or the album, person (as the viewer sees it) or photo
  title.
- One `h1` per page and no skipped levels, keeping today's visual sizes. Search gets a visually hidden `h1`; with a
  hero, the album name in it is the `h1`.
- "Skip to main content" link, visible on focus, targeting the main area.
- Pagination controls get names: "Previous page", "Next page", "Page N".
- Targets at least 24x24px: Ignore face, album card Share, back links, "Open photo", "View original", the photo
  page's album and map links.
- `loading="lazy"` on Dashboard and album card images after the first row (the first four), which stay eager. The
  review grid's hidden loaders are untouched.

### 5. Person page faces

- `GET /people/:id/faces?photos=<id,id,...>`: 1 to 48 ids after de-duplication, else 400. Read token and viewer
  email; added to the Pages proxy GET allowlist (POST on the same path is unchanged).
- Returns `{ faces }`: that person's `confirmed` and `auto` faces in those photos that the caller can see
  (`scopeFor`), serialized like `GET /photos/:id/faces`. An unknown or invisible person or photo yields nothing, so
  nothing is revealed and no separate role check is read.
- One statement, `json_each` over the ids as the outer table, faces on `idx_faces_photo_id`; unary `+` on person and
  status so the planner never walks all of the person's faces. Plan pinned in `query-plans.test.ts`.
- Frontend: only when the person is `canEdit`, query `['person-faces', personId, photoIds]`, one per shown page; the
  tiles take their faces as props. Invalidated everywhere `photo-faces` is. While loading, no controls (as today); on
  failure one "Could not load photo actions" line with "Try again".

## Performance

- Worker and D1, person page: up to 48 invocations become 1. Reads about the same face rows (all faces of the shown
  photos) with the repeated access reads gone; 0 writes. CPU maps only this person's faces on at most 48 photos.
  Measure locally with the query plan and rows read, after deploy with `wrangler tail` and `wrangler d1 insights`.
- Everything else is frontend only. Nothing adds a request.
- Deploy window: a new page against the old Worker shows the failure line until the Worker is updated.

## Tests and docs

Frontend tests for each behaviour above; Worker tests for the route (visibility, viewer names, ignored and unassigned
excluded, limits, plan) and the proxy allowlist. Mock API handler. A 390px and 1280px browser check of every page.
`README.md`, `AGENTS.md` and `docs/` in the same commit as the change.

## Left to the builder

Component and hook file names, tile spacing, and how the work is split into commits.
