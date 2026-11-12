# Known people list

`people.json` is the curated list of public figures the agent can recognize in your photos. Each entry is a Wikidata id, a display name and optional aliases, one object per line, sorted by name. Reference photos come only from openly licensed Wikimedia Commons images (`build-known-gallery`).

All commands run from `agent/` as `npx tsx --env-file=.env src/cli.ts <command>`.

## Add a person

1. Pick who to add: people who plausibly appear in your photos. India first, then global. Prefer people with several openly licensed photos on Commons (a Commons category with many files is a good sign).
2. Find the Wikidata id: `known-search "<name>"`. Humans are listed first, then by popularity. Check the description and the portrait/category flags, and beware of namesakes.
3. Add it: `known-add --id Q123 [--name "Display Name"] [--alias "Other Name"]...`. It refuses duplicates, non-humans and ids with neither a portrait nor a Commons category, and keeps the file sorted.
4. Verify the list: `known-check` (online, in batches of 50 ids) or `known-check --offline`. It prints issues and exits 1 when there are any.
5. Build references: `build-known-gallery`. It is incremental, fetches only the new people, and reports reference counts. People with fewer than 3 usable photos are excluded, listed, and remembered in the gallery file, so later runs skip them. Retry them with `--retry-excluded` (all) or `--rebuild <id>` (one); `--full` ignores the existing file and rebuilds everyone. Wikimedia errors are not remembered: those people are retried on every run.

   Set `WIKIMEDIA_CONTACT` in `agent/.env` (an email or a project URL, for example `WIKIMEDIA_CONTACT=you@example.org`) before building. It is sent only in the User-Agent (`face-gallery-builder/0.1 (<contact>)`), is never logged or committed, and moves you from Wikimedia's unidentified bucket (10 API requests per minute) to the identified-bot bucket (200 per minute), see [Wikimedia API rate limits](https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits). Without it the build still works but waits 6.5 s between requests; with it, 1.5 s.

   The crawl is slow on purpose: API requests are paced (1.5 s apart with a contact, 6.5 s without, doubling up to 8 s after a throttle and easing back after 20 successes), strictly one at a time, and only jpg, jpeg, png and webp files are fetched. Requests are batched: Wikidata claims for 50 people, and Commons file info for up to 50 files, per request, so a typical person costs about 4 API requests (the build prints an estimate at the start). When Wikimedia answers 429 the agent waits as long as it asks (`Wikimedia asked to slow down: waiting Ns`) and retries. If 5 people in a row still fail on rate limiting, the build saves what it has and stops with `Wikimedia is rate limiting this machine; wait a few minutes and rerun, finished people are kept` (exit code 1). Rerunning is safe and incremental: finished people are kept and the failed ones are retried.
   Backup: the saved gallery is pushed to your private R2 bucket at the end of a changed build. On a new machine, `known-gallery-pull` (or `build-known-gallery`, which restores the backup first when the local file is missing, then fetches only missing people) avoids the multi-hour crawl; a model mismatch triggers a full rebuild and a corrupt backup is ignored with a warning. `known-gallery-push` backs up explicitly; `known-gallery-pull --force` overwrites an existing local file. An unchanged build also checks R2 (a cheap status call) and pushes when no backup exists yet, so an existing local gallery is backed up by the next `build-known-gallery`. A failed push or check only warns (the local file is saved). `--full` skips the restore.
6. Match existing photos: run `backfill-known --dry-run` first (writes nothing, prints counts, per-person top 20, a score histogram and 10 sample face ids), then `backfill-known`. It fills faces that have no known match yet. A face already matched to someone is not reconsidered, so use `--rescore` after threshold changes, after removing a person or after `--rebuild` of one (the Worker writes only rows that change). If the Worker's embeddings route is slow, lower the page size with `--page-size <n>` (1 to 100). Entries must fit the Worker's limits (name up to 200 characters, up to 20 aliases of up to 100 characters); `known-check` reports violations.

Note: a rescan (`index-*`, `backfill-faces --recrop`) on a machine without the gallery file resets known matches on the rescanned unassigned and auto faces; a normal `backfill-known` restores them.

## Pick faces by hand (excluded people)

`known-pick [--id <Q-id>...] [--port <n>]` (from `agent/`, needs the sidecar and `WIKIMEDIA_CONTACT` like the build) works through the people recorded as excluded, or only the `--id` ones. It prints a URL on `127.0.0.1` with a random per-run token; open it. For each person it shows the same candidates as the build (Wikidata portrait plus Commons category files, raster, openly licensed only, license shown under each photo) with numbered boxes on every detected face.

- Single-face photos start picked. In group photos the face closest to the current picks (max cosine) is outlined with a dashed amber box as a suggestion; it is not picked until you click it. Click a box (or Tab to it and press Space) to toggle.
- Save (Enter) needs at least 3 picks; at most 10 are stored. Skip (S) leaves the person excluded. Done (D) or Ctrl+C ends the run.
- Saved people are trusted: no outlier filter. A picked face with cosine below 0.3 against the median of the other picks gets a red box and a warning.
- Saving writes the gallery file atomically (temp file, then rename), removes the person from the excluded record and never touches other people. On exit, if the gallery changed, it is pushed to R2 (a failure only warns; run `known-gallery-push`).
- Crawls run one at a time; the next person is fetched in the background. Images, face boxes and embeddings are cached under `agent/.index-state/known-pick-cache/` (uncommitted), so a restart reuses them. Delete that folder to refetch.
- Run `backfill-known --rescore` afterwards so already indexed faces see the new references.

## Remove a person

Delete the entry from `people.json`, run `build-known-gallery` (the person leaves the gallery), then `backfill-known --rescore` to clear their old matches.

## Fix a weak person

If a person matches badly or has too few references, run `build-known-gallery --rebuild <id>` to refetch just that person. If they stay weak, remove them or check their Commons category.

## Group photos and URL limits

Photos with one face are the primary references. After that pass, photos with 2 to `MAX_GROUP_FACES` (12) faces are used too, but only
when the person already has at least one accepted single-face ref (the portrait counts) to act as an anchor. For each such photo every
face (detection score at least `MIN_DET_SCORE`) is compared with the anchors using the maximum cosine over the anchors (a mean would blur
pose and age differences). The best face is taken only if its cosine is at least `GROUP_MIN_COSINE` (0.5) and it beats the second-best face
in the photo by `GROUP_MARGIN` (0.1); its own embedding is stored, and the usual outlier check against the person's median still applies.
At most `GROUP_PHOTO_LIMIT` (15) group photos are tried per person, and the build stops adding once `MAX_REFS` is reached. Photos with no
face or more than 12 faces are skipped. Progress shows `group X: picked face (cos 0.61)` or `skip X: no confident face among N`, and the
final line reports how many refs came from group photos. Constants are in `agent/src/known/buildGallery.ts` next to `MAX_REFS` and
`MIN_REFS`; they are first guesses, tune them if people end up with wrong faces (raise `GROUP_MIN_COSINE`/`GROUP_MARGIN`) or too few refs.

Batched Wikimedia requests (titles, Wikidata ids) are chunked so the encoded `|`-joined value stays under `MAX_QUERY_CHARS` (6000) in
addition to the 50 item cap; this avoids HTTP 414 on people with long file names.
