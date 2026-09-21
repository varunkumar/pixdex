# PixDex

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

   Copy `.env.example` to `.env` and set `VITE_WORKER_API_BASE_URL` to your
   deployed worker's URL:

   ```
   VITE_WORKER_API_BASE_URL=https://pixdex-worker.<your-subdomain>.workers.dev
   ```

3. Start the development server:

   ```bash
   npm run dev
   ```

## Originals (optional)

Search results and the daily pick show thumbnails only by default. To enable
"View Original" for local-disk photos (Drive-sourced photos always deep-link
to Drive, no setup needed), follow `agent/cloudflared/README.md` once, then
set `VITE_ORIGINALS_BASE_URL` and `VITE_ORIGINALS_TOKEN` in this app's `.env`
to match.

## Testing

```bash
npm test
```

## Building

```bash
npm run build
```

## Project Structure

- `src/components` - React UI components (Search, Albums, DailySuggestion, Dashboard, Navigation)
- `src/services/api` - `WorkerApiClient`, used to call the deployed worker
- `src/types` - TypeScript type definitions

## Contributing

1. Fork the repository
2. Create your feature branch
3. Submit a pull request

## License

MIT
