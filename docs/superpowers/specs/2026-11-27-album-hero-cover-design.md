# Album hero cover - design

## Intent

Show the album's cover photo as a large, sharp banner at the top of the album page. Thumbnails are at most
400px, too small for this, so a larger copy of the cover is made from the original, once, and reused.

## Approaches

| Approach | Trade-off | Decision |
|---|---|---|
| A. Browser loads the original and caches it | Smallest, but every device downloads the full file and needs the source online | Not chosen |
| B. Owner's browser makes a resized copy once and stores it in R2 | Automatic, works with the source offline afterwards; viewers wait for an owner visit | **Chosen** |
| C. Indexing agent makes the copies | Upload stays ingest-only, but must be re-run after cover changes | Not chosen |

Accepted caveat: header images are now stored in R2 as well, no longer only local disk or Google Drive.
This is a resized copy (2048px long side). Full originals are still never stored in R2.

## Behaviour

- The hero sits under "All albums", above the tabs, on every tab. About 340px tall, 220px on phones.
  The photo fills it (cropped, centred). Album name and photo count sit bottom left in white over a dark
  gradient. Share, avatars, the "Shared by" badge, sort and columns stay in a row below.
- An album with no cover thumbnail keeps today's header.
- While the hero image is loading or missing, the cover thumbnail is shown blurred.
- If it is missing and the viewer owns the album, the browser fetches `/api/originals/:coverId`, resizes it
  to a 2048px long side (never enlarging, EXIF orientation applied), encodes JPEG (quality 0.85, lowered if
  over 2 MB), uploads it and shows it.
- Offline source or a format the browser cannot decode (such as HEIC): the blurred thumbnail stays, no error
  message. Not retried in the same page session; the next visit tries again.
- A newly chosen cover gets its hero the same way. Going back to an earlier cover reuses the stored one.

## Parts

- Worker, R2 key `hero/<contentHash>.jpg` in the existing `THUMBNAILS` bucket:
  - `GET /heroes/:contentHash`: same visibility check as thumbnails; 404 if not visible or not made yet;
    immutable, private, one year.
  - `PUT /heroes/:contentHash`: guarded write. 404 if not visible, 403 for a viewer, 400 for a bad hash or
    a body that is not a JPEG, 413 over 2 MB. Written once: if the object exists, 200 and nothing changes
    (conditional R2 put, so two tabs cannot overwrite each other). Otherwise 201.
- Pages Function: allow the GET (immutable cache, errors `no-store`) and this one binary PUT, requiring
  `Content-Type: image/jpeg` and forwarding bytes. Other writes stay JSON only.
- Frontend: an `AlbumHero` component and a small service for resize and upload.
- `dev/mockApi.ts` serves the new routes. README, AGENTS.md and `docs/architecture.md` are updated,
  including the "originals never leave local disk or Google Drive" statement.

## Non-goals

No D1 migration, no agent change, no heroes on the albums list, no focal point or crop control, no cleanup of
heroes for old covers, no replacing a stored hero (delete the R2 object by hand if one is bad).

## Performance

- Hero view: one D1 read (visibility, by content hash) and one R2 get, then cached by the browser. A missing
  hero is the D1 read plus one R2 get returning nothing, once per page session.
- Creation, once per cover photo: one original view (one existing access check, one Drive call for Drive
  photos), one D1 read and one conditional R2 put.
- Worker CPU: no image work; at most a 2 MB body is read and passed to R2. Not measurable locally; check
  with `wrangler tail`.

## Rollout

No ordering needed: if the frontend deploys before the Worker, the hero stays on the blurred thumbnail.
