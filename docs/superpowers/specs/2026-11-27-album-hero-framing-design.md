# Album hero: browser storage and reposition - design

Changes `2026-11-27-album-hero-cover-design.md`, which this replaces where they differ.

## Intent

- No header images in R2. Each browser keeps the cover's original file, one per album, so old covers are not kept.
- The owner can move and zoom the cover inside the banner, and everyone who can see the album gets that framing.

## Approaches (image storage)

| Approach | Trade-off | Decision |
|---|---|---|
| A. IndexedDB, one record per album | Roomy, mobile and desktop, a little more code | **Chosen** |
| B. `localStorage` | About 5 MB of text, only a few albums fit | Not chosen |
| C. Browser HTTP cache of the original | Least code, large files, evicted at any time | Not chosen |

Framing is saved with the album in D1, not in the browser.

## Browser storage

- Database `pixdex`, store `heroes`, key: album name. Record:
  `{ album, contentHash, status: 'ready' | 'unavailable' | 'undecodable', image?: Blob, updatedAt }`.
- Opening an album page reads the record. If its `contentHash` equals the current cover's:
  - `ready`: show the stored image. No network request for the hero.
  - `unavailable`: show the blurred thumbnail and try the original again.
  - `undecodable`: show the blurred thumbnail and do not try again.
- No record, or another cover's record: fetch `/api/originals/:coverId` and overwrite the record with it.
- Every visit to the album page retries an `unavailable` record, including returning to it without reloading.
  There is no back-off. Two mounts at once share one attempt.
- `unavailable`: network error, any non-OK status (tunnel down, agent off, Drive failure, access error), or a
  response whose content type is not `image/*` (such as a sign-in or error page served with 200).
- `undecodable`: an `image/*` response the browser cannot decode (such as HEIC in Chrome). Retrying
  would download the same full file every visit; another browser, or a new cover, tries again.
- Viewers make their own copy the same way; the existing originals access check already allows it.
- IndexedDB missing, blocked or full: the page still works and shows the image it just fetched; it is fetched again
  next visit. Errors are never shown.
- A browser may clear the store (Safari can after about a week without visits); the copy is then made again.
- The file is stored exactly as served: no resizing, re-encoding or size cap. The browser applies EXIF
  orientation when showing it, and transparent areas show the banner's background. Storage grows by about one
  original (often several MB) per album visited.

## Reposition and zoom

- Owner only: a "Reposition" button on the banner, shown once the sharp image is showing.
- Edit mode: drag to move (mouse or touch), slider or pinch to zoom from 1x to 3x, arrow keys move by 1%
  (10% with Shift), `+` and `-` zoom. The title text is hidden and the page does not scroll while dragging on
  the banner. "Save", "Cancel" and "Reset" (centre, 1x). A failed save keeps edit mode and shows the error.
- Framing is `{ x, y, zoom }`: x and y are 0 to 100 (focal point), zoom 1 to 3. Rendered with
  `object-fit: cover`, `object-position: x% y%`, `transform-origin: x% y%`, `transform: scale(zoom)`, which
  never leaves a gap and works for both banner shapes. The blurred thumbnail uses the same position.
- Storage: migration `0022` adds nullable `albums.cover_framing` (JSON `{ hash, x, y, zoom }`). It is an
  owner-edited column like `shared_with`; triggers do not touch it. It is lost if the album empties and its row
  is removed.
- It applies only while `hash` equals the album's current cover, so a new cover shows centred at 1x. Going back to
  the earlier cover restores its framing unless another cover was framed in between.
- `PUT /albums/framing` `{ album, contentHash, x, y, zoom }`: guarded write, owner only (404 not visible, 403
  viewer), 400 out of range, 409 if `contentHash` is not the current cover. Centre at 1x stores NULL. Added to
  the Pages proxy's PUT allowlist (JSON).
- `GET /albums` (paged shape) adds `coverFraming: { x, y, zoom } | null` for owners and viewers.

## Removed

The `/heroes` Worker routes, their tests, the proxy hero paths and binary PUT branch, the dev mock's hero path,
the canvas resize and upload code,
and the docs saying header images are in R2. Existing `hero/` objects in the `pixdex-thumbnails` bucket are
deleted by hand after deploy.

## Non-goals

Per-device framing, separate desktop and phone framing, rotation, framing on the albums list, syncing images
between devices, clearing records of deleted albums, any agent change.

## Constraints and access

Originals are never stored on Cloudflare. They are now kept in viewers' browsers too, and a stored copy stays in that browser after access is revoked, but the
album page, which is the only thing that shows it, no longer loads for that user.

## Performance

- Stored hero: no request (previously one D1 read and one R2 get per uncached view).
- Making one: one original view (one access check, and one Drive call for Drive photos), once per browser and
  cover. While unavailable, that repeats on each album page visit.
- `GET /albums`: one more column, no extra rows. Saving framing: one albums primary-key read and one row written.
- Worker CPU: a small JSON parse per album row with framing (at most 48). No image bytes pass through the Worker.

## Left to the builder

Component and file split, button placement and styling, and how the dev mock serves a decodable original.
