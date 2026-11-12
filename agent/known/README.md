# Known people list

`people.json` is the curated list of public figures the agent can recognize in your photos. Each entry is a Wikidata id, a display name and optional aliases, one object per line, sorted by name. Reference photos come only from openly licensed Wikimedia Commons images (`build-known-gallery`).

All commands run from `agent/` as `npx tsx --env-file=.env src/cli.ts <command>`.

## Add a person

1. Pick who to add: people who plausibly appear in your photos. India first, then global. Prefer people with several openly licensed photos on Commons (a Commons category with many files is a good sign).
2. Find the Wikidata id: `known-search "<name>"`. Humans are listed first, then by popularity. Check the description and the portrait/category flags, and beware of namesakes.
3. Add it: `known-add --id Q123 [--name "Display Name"] [--alias "Other Name"]...`. It refuses duplicates, non-humans and ids with neither a portrait nor a Commons category, and keeps the file sorted.
4. Verify the list: `known-check` (online, in batches of 50 ids) or `known-check --offline`. It prints issues and exits 1 when there are any.
5. Build references: `build-known-gallery`. It is incremental, fetches only the new people, and reports reference counts. People with fewer than 3 usable photos are excluded and listed.
6. Match existing photos: `backfill-known` fills faces that have no known match yet. Use `--rescore` only after threshold changes, because a face already matched to someone else is not reconsidered.

## Remove a person

Delete the entry from `people.json`, run `build-known-gallery` (the person leaves the gallery), then `backfill-known --rescore` to clear their old matches.

## Fix a weak person

If a person matches badly or has too few references, run `build-known-gallery --rebuild <id>` to refetch just that person. If they stay weak, remove them or check their Commons category.
