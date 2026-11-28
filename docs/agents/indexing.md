# Agent: indexing, Google Drive and originals

Agent notes. Read this file before you change this area. Update it with each change.
The core rules are in [`AGENTS.md`](../../AGENTS.md). Paths are relative to the repository root.

- `agent/` - local Node/TS indexing CLI, originals server, and the `move-album` script. The originals server serves
  local files and Google Drive files (`openDriveFileStream` in `google/driveFiles.ts`, agent's stored OAuth token, lazily built, piped
  with no staging; Drive's `Content-Type` and `Content-Length` are passed on, read from the client's `Headers` object with `get()`, and the album hero accepts only `image/*`; a missing/invalid token or Drive failure is a 404; no Range support yet); the frontend uses `/api/originals/:id`
  for both sources (`src/services/originals.ts`) and the photo page shows "Open in Google Drive" via `getDriveUrl` (owner only).
  Agent-only: no Worker CPU or D1 change, one Drive API call per original view
- Drive listing (`google/driveScan.ts`, `DriveScanner`): folders are listed 6 at a time (`concurrency`), 1000 entries per `files.list` page
  (the API maximum; the default is 100), and each folder's photos are handed to `indexGoogleDriveFolder` as soon as that folder is
  listed, so indexing starts after the first list call and listing overlaps with the slow Ollama work (nothing needs the whole tree:
  the Processed rule needs one folder's full listing, `check-hashes` needs a batch, in-run dedup needs a growing set). A subfolder that
  cannot be listed (after retries) is reported (`Failed listing ...`, counted in `failed`) and the walk continues; a failing root
  throws. Progress lines: `Listing: N folders, M photos found so far` (every 5 s) and `Listing finished: ...`. `check-hashes` is sent
  per batch of up to 500 not-yet-checked checksums made of every photo that arrived since the previous batch (the first batch is one
  folder, later ones are large because indexing is slower than listing): the same rows read in total, at most about `photos / 500`
  plus a handful of extra Worker requests compared with one global call.
- `index-drive` log lines (for measuring throughput): every line starts with an ISO-8601 UTC timestamp (added in `driveCli.ts`). An `Indexed:` line
  carries the album, folder path, file size, download / index / total time, per-stage seconds (`StageTimings` from `processFile`: exif, analyze, rate, caption, hashtags, thumbnail, species, ingest, faces; stages that did not run are left out) and the running `#N`; `Skipping` and `Failed` lines carry the folder path
  and size. A `Progress:` line every 5 minutes and a final `Summary:` line give indexed / skipped / failed counts, photos per minute overall and over
  the last 20 indexed, queued vs found photos, folders listed, elapsed time and an upper-bound ETA for the queued photos (some will be skipped, and
  the listing may still be running). Agent-only: no Worker CPU or D1 change.
- Drive selection rules (`scanDriveFolder` in `google/driveScan.ts`, per folder, after all its listing pages): a folder with a `Processed`
  subfolder (case-insensitive) contributes only that subfolder (its own photos and other subfolders are ignored), otherwise its own photos
  plus every subfolder, recursively; camera RAW (`isRawFile`: extension list or `image/x-<vendor>` mime) is always ignored. The
  `index-drive` folder search shows each result's parent name (one `get` per distinct parent, at most 50, failures only lose the hint).
- `index-drive --dry-run` (`google/dryRunDriveFolder.ts`): directory-tree report with per-folder counts and what was ignored, no download, no Ollama, no sidecar, no writes; one
  read-only `check-hashes` per 500 advertised checksums (a failure only warns). Worker CPU and D1: no change beyond those reads.
- Google Drive indexing (`agent/src/google/`, `agent/src/driveCli.ts`, command `index-drive [--dry-run] [--folder <id-or-url>]...`): recursive over
  subfolders, includes shared drives (`corpora: 'allDrives'`, `supportsAllDrives`), album from `albumFromDrivePath`
  (the first folder under the picked one, so deep trees with generic leaf names like "001" or "FB" do not merge albums; differs from local
  `albumFromPath`), skips folders matching `DEFAULT_EXCLUDED_FOLDERS` (`*.lrdata`, `*.aep`, `Adobe After Effects Auto-Save`, `(Footage)`,
  `*_AME`, `allresources`, `*.collagefactoryfree`) plus any `--exclude <glob>` (never a Processed folder), skips already-indexed photos by Drive's `sha256Checksum` (equals `sha256ContentHash`) with one batched
  `check-hashes` before any download (files without a checksum are downloaded and checked as before), skips in-run duplicate content,
  retries 429, rate-limit 403, 5xx and network resets (`withDriveRetry`), and on `invalid_grant` deletes `agent/.google-token.json`
  and exits 1. Local storage (`google/staging.ts`): the current photo plus the prefetched next one (at most two) staged in `<tmpdir>/pixdex-drive-staging`, each deleted after its photo
  A file over `DRIVE_STAGING_MAX_MB` (optional env, default 1024) is refused before download (listing `size`) and again after
  (actual size); `pixdex-drive-*` files older than 1 hour are swept at the start of each run (orphans of a killed run). Agent-only: no Worker route, CPU or D1 change (the Worker sees the same `POST /ingest/photo`; fewer `check-hashes`
  calls per file, now one per 500 photos plus one per checksum-less file).
- Indexing overlap (`processFile.ts`, `google/indexGoogleDriveFolder.ts`): the face and species sidecar calls start right after EXIF and run while the
  vision model works (they need only the picture and the region; `detectSpecies` is the sidecar half of `identifySpecies`, `decideSpecies` runs after
  `analyze` because its animal cue needs the model's subjects; `scanFaces` takes the started `detection` promise). Their stage seconds overlap
  `analyze`, so the stage times on an `Indexed:` line can add up to more than the total. `index-drive` also downloads and hashes the next photo of the
  batch while the current one is indexed (the `download` seconds are then hidden behind the previous photo; `total` is the wall time from taking the photo
  to finishing it). A failed prefetch is reported against its own photo. Agent-only: no Worker route, CPU or D1 change; the sidecars now share the
  machine with Ollama while it works, so `analyze` can run a little slower.
- Thumbnail orientation (`agent/src/thumbnail.ts`): new thumbnails are stored upright (`.rotate()` applies the EXIF orientation, sharp drops the tag),
  so phone photos are no longer sideways. Thumbnails indexed before this change are still in the raw sensor frame and are left as they are. Face boxes
  must be in the same frame as the photo's thumbnail (the UI draws them over it): `scanFaces(..., { boxFrame })` is `upright` from `processFile` and `raw`
  (the default) from `backfill-faces`, so a post-change photo whose scan was missed at index time gets raw boxes from `backfill-faces` (wrong for a rotated
  photo; re-index it instead). Agent-only: no Worker route, CPU or D1 change; one extra in-memory rotate per thumbnail.
- Photo places (migration `0025_photo_place.sql`, `photos.place`: NULL until resolved, `''` when no town is near, not
  searchable). Ingest-token routes, out of the proxy allowlist: `POST /ingest/places/pending` (`{ cursor?, limit }`,
  at most 100, photos with GPS and `place IS NULL`, rowid paging) and `POST /ingest/places` (up to 100 by content hash).
  `POST /ingest/photo` takes an optional `place`; absent keeps it only while the GPS position is the same.
  `POST /ingest/exif` clears it when the position changes. Performance: one full `pending` pass reads each photo row
  once; each stored place is one row write plus the FTS rewrite of that photo.
