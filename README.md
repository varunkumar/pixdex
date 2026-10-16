# PixdeX

[![Frontend build](https://img.shields.io/github/check-runs/varunkumar/pixdex/main?nameFilter=Cloudflare%20Pages&label=frontend%20build)](https://github.com/varunkumar/pixdex/commits/main)
[![Worker build](https://img.shields.io/github/check-runs/varunkumar/pixdex/main?nameFilter=Workers%20Builds%3A%20pixdex-worker&label=worker%20build)](https://github.com/varunkumar/pixdex/commits/main)

A browse and search UI for a personal photo collection.

## Architecture

This repository (the frontend) is a React app that talks directly to a deployed
Cloudflare Worker for search, albums, the daily pick, and thumbnails. It does not
run any backend of its own.

- `src/` - the frontend (this app): browse/search UI, calls the worker via
  `WorkerApiClient`
- `worker/` - the deployed Cloudflare Worker that serves `/search`, `/albums`,
  `/photos/:id`, `/daily-pick` (nature and wildlife only, no people), and thumbnails
- `agent/` - a separate local agent used to index photos (from local
  directories or Google Drive) into the store the worker reads from; indexing
  is not done through this web UI

## Prerequisites

- Node.js 18+
- A deployed instance of the `worker/` (see `worker/package.json` for its own
  scripts)

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Configure environment variables:

   Copy `.env.example` to `.env` and set `WORKER_URL` to your deployed
   worker's URL, and `READ_TOKEN` to the same value as the worker's
   `READ_TOKEN` secret. These are **not** `VITE_`-prefixed on purpose: they are
   used only by the dev server's `/api` proxy (`vite.config.ts`) and, in
   production, by the Pages Function in `functions/api/` (set `READ_TOKEN` and
   `WORKER_URL` as Pages secrets). The browser only ever talks to same-origin
   `/api/*`, so the read token never ships in the bundle:

   ```
   WORKER_URL=https://pixdex-worker.<your-subdomain>.workers.dev
   READ_TOKEN=<same value as the worker's READ_TOKEN secret>
   ```

3. Start the development server:

   ```bash
   npm run dev
   ```

## Rating and correcting the AI

On a photo's page, "Your review" lets you give 1-5 stars and edit the AI's
title, subjects (species) and tags. Edits live in separate columns, so
re-indexing never overwrites them, and search is re-indexed from your text (a
corrected species stops matching the model's wrong one). "Reset to AI" undoes
them. Your stars are blended with the model's aesthetic score (70% yours, 30%
the model's, on a 1-10 scale; the model's alone when you have not rated). That
combined score drives "Best rated" on the search and album pages, album average
ratings and the daily pick. The search page has a "Sort by" control (best match
by default) and a "People" filter (up to 5 named people; photos containing all selected people). The description and suggested caption are not editable.

## Camera details

Indexing also stores camera make/model, lens, focal length, aperture, shutter
speed, ISO and GPS (when the file has it) as columns, and shows them on result
cards. To fill these in for photos that were indexed earlier, without another
vision pass:

```bash
cd agent && npm run dev -- backfill-exif "/path/to/folder"
```

## Faces

Face scanning is optional and runs locally. Start the InsightFace sidecar
(setup and run commands are in `agent/sidecar/README.md`), set
`FACE_SIDECAR_URL=http://127.0.0.1:8799` in `agent/.env`, and indexing will
detect faces after each photo (a sidecar failure is logged and never fails the
photo). To scan photos that were indexed earlier:

```bash
cd agent && npm run dev -- backfill-faces                       # every indexed local photo not yet scanned
cd agent && npm run dev -- backfill-faces "/path/to/folder"     # only photos indexed from that folder
```

It follows the index, not the disk: the Worker lists the local photos still unscanned (with the path each was
indexed from), so folders are never walked or hashed. Photos whose file is not on disk right now (a drive that is
not mounted) are counted as "File missing" and picked up on a later run. It is resumable: a re-run only does what
is left. Faces can be named or corrected on each
photo's page. The People page (`/people`) lists named people (round cover face and name) and groups of similar unnamed faces, both paged like the other lists (page size and page in the URL for people; the groups load from the Worker a page at a time as you move through them). Faces are drawn as circles everywhere: name a
group or add it to an existing person, and the app then looks for that person's other faces. A person's
page (`/people/:id`) shows their photos, lets you rename or delete them, review suggested matches, and
re-run matching. Once someone is named, new faces are matched to them automatically at ingest. Matching
is also automatic when you name a group or face. Lower-confidence matches (score 0.4 to 0.5) land in a
"Review suggestions" queue on the person's page. "Not X" on a face rejects that match permanently. "Remove name" (confirmed faces only) is soft: it just unassigns the face. `FACE_SIDECAR_URL` must be a loopback address (127.0.0.1, localhost or [::1]).
A person's cover (the face shown on the People grid, their page and the search filter) is by default their
biggest confirmed face (a larger box means more pixels in the thumbnail), and you can pick another with
"Set as cover" on their page or on a photo's face list; if the picked face is later removed from them, the cover
falls back to the default. In an unnamed group the largest faces are shown first.
The app can also filter search by up to 5 people. The browser writes involved are `PATCH`/`DELETE
people/:id` and `POST` to `people`, `people/:id/faces`, `people/:id/match`, `people/:id/cover` and
`faces/:id/assign|reject|unassign`, all through the Pages proxy. Licence: the InsightFace weights are
non-commercial, so this is for personal use only.

## Indexing many folders (resumable)

`index-batch` indexes every `<album>/Processed` folder under one or more roots
(and skips `Unprocessed`), one album at a time, and records progress in
`agent/.index-state/queue.json`. Stop it, reboot, or lose the disk at any point:
running it again picks up where it left off, because finished albums are not
revisited and photos already in the index are skipped by content hash.

```bash
cd agent
npm run dev -- index-batch /Volumes/T9/Varun/Photos "/Volumes/T7Shield/Varun/Bandipur (12,13,14-Sep-2026)"
npm run dev -- index-status            # progress, ETA, what is pending/failed
npm run dev -- index-status --json
```

- Album folders (a folder that itself contains `Processed`) and roots (a folder
  of albums) can be mixed. Re-running rediscovers: new albums are queued, and a
  finished album is queued again if its number of photos changed.
- `--priority=bandipur,nagarhole` runs matching albums first (regexes, comma
  separated; the default puts wildlife albums first). `--retry-failed` retries
  albums that finished with failed photos.
- It waits (and logs why) when Ollama or the Worker is unreachable or a disk is
  not mounted, instead of recording failures.
- To start it automatically at login and restart it after a crash, run
  `agent/scripts/install-launchd.sh <folders...>` once (`--uninstall` removes
  it). Logs go to `agent/.index-state/batch.log`.

## Originals (optional)

Search results and the daily pick show thumbnails only by default. To enable
"View Original" for local-disk photos (Drive-sourced photos always deep-link
to Drive, no setup needed), follow `agent/cloudflared/README.md` once. The
browser never sees the tunnel URL or its token: links go to the same-origin
`/api/originals/:id` proxy, which needs `ORIGINALS_BASE_URL` and
`ORIGINALS_TOKEN` set as Pages secrets (and in `.env` for local dev).

## Tests and deploys

There is no GitHub Actions pipeline. `.githooks/pre-commit` (enabled by
`npm install`) runs the lint/test/build suites touched by the staged changes.
Cloudflare builds and deploys both the frontend (with `functions/`) and the
Worker from `main` via its GitHub integration (Pages for the frontend, Workers
Builds for `worker/`). Frontend build command is
`npm run build`, output `dist`. The Worker's deploy command also applies pending D1
migrations (`npx wrangler d1 migrations apply DB --remote && npx wrangler deploy`), so
a merged migration runs on production before the new code goes live. See
`docs/development.md` for deploy notes.

## Testing

```bash
npm test
```

## Building

```bash
npm run build
```

## Project Structure

- `src/components` - React UI (Search, Albums, AlbumPhotos, PhotoDetail,
  DailySuggestion, Dashboard, Lightbox, Layout)
- `src/hooks`, `src/services`, `src/types` - list/sort URL state, `WorkerApiClient`
  and helpers, API types
- `functions/api` - Pages Function: same-origin proxy that adds the read token
  (read routes plus the album cover, photo review and people/face writes)
- `worker/` - Cloudflare Worker (Hono, D1, R2) and its migrations
- `agent/` - local indexing CLI and originals server
- `docs/` - [architecture](docs/architecture.md),
  [development guide](docs/development.md), plans and specs

Agent-oriented summary: `AGENTS.md`. Update this README and `AGENTS.md` with
every feature or change.

## Contributing

1. Fork the repository
2. Create your feature branch
3. Submit a pull request

## License

MIT
