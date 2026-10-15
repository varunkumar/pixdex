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
  `/photos/:id`, `/daily-pick`, and thumbnails
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

## Camera details

Indexing also stores camera make/model, lens, focal length, aperture, shutter
speed, ISO and GPS (when the file has it) as columns, and shows them on result
cards. To fill these in for photos that were indexed earlier, without another
vision pass:

```bash
cd agent && npm run dev -- backfill-exif "/path/to/folder"
```

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
`npm run build`, output `dist`. D1 migrations are not applied by the deploy:
run `cd worker && npx wrangler d1 migrations apply DB --remote` before pushing
code that needs a new schema. See `docs/development.md` for deploy notes.

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
