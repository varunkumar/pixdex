# Known people list

`people.json` is the curated list of public figures the agent can recognize in your photos. Each entry is a Wikidata id, a display name and optional aliases, one object per line, sorted by name. Reference photos come only from openly licensed Wikimedia Commons images (`build-known-gallery`).

All commands run from `agent/` as `npx tsx --env-file=.env src/cli.ts <command>`.

## Add a person

1. Pick who to add: people who plausibly appear in your photos. India first, then global. Prefer people with several openly licensed photos on Commons (a Commons category with many files is a good sign).
2. Find the Wikidata id: `known-search "<name>"`. Humans are listed first, then by popularity. Check the description and the portrait/category flags, and beware of namesakes.
3. Add it: `known-add --id Q123 [--name "Display Name"] [--alias "Other Name"]...`. It refuses duplicates, non-humans and ids with neither a portrait nor a Commons category, and keeps the file sorted.
4. Verify the list: `known-check` (online, in batches of 50 ids) or `known-check --offline`. It prints issues and exits 1 when there are any.
5. Build references: `build-known-gallery`. It is incremental, fetches only the new people, and reports reference counts. People with fewer than 3 usable photos are excluded, listed, and remembered in the gallery file, so later runs skip them. Retry them with `--retry-excluded` (all) or `--rebuild <id>` (one); `--full` ignores the existing file and rebuilds everyone. Wikimedia errors are not remembered: those people are retried on every run.
   Backup: the saved gallery is pushed to your private R2 bucket at the end of a changed build. On a new machine, `known-gallery-pull` (or `build-known-gallery`, which restores the backup first when the local file is missing, then fetches only missing people) avoids the multi-hour crawl; a model mismatch triggers a full rebuild and a corrupt backup is ignored with a warning. `known-gallery-push` backs up explicitly; `known-gallery-pull --force` overwrites an existing local file. A failed push only warns (the local file is saved). `--full` skips the restore.
6. Match existing photos: run `backfill-known --dry-run` first (writes nothing, prints counts, per-person top 20, a score histogram and 10 sample face ids), then `backfill-known`. It fills faces that have no known match yet. A face already matched to someone is not reconsidered, so use `--rescore` after threshold changes, after removing a person or after `--rebuild` of one (the Worker writes only rows that change). If the Worker's embeddings route is slow, lower the page size with `--page-size <n>` (1 to 100). Entries must fit the Worker's limits (name up to 200 characters, up to 20 aliases of up to 100 characters); `known-check` reports violations.

Note: a rescan (`index-*`, `backfill-faces --recrop`) on a machine without the gallery file resets known matches on the rescanned unassigned and auto faces; a normal `backfill-known` restores them.

## Remove a person

Delete the entry from `people.json`, run `build-known-gallery` (the person leaves the gallery), then `backfill-known --rescore` to clear their old matches.

## Fix a weak person

If a person matches badly or has too few references, run `build-known-gallery --rebuild <id>` to refetch just that person. If they stay weak, remove them or check their Commons category.
