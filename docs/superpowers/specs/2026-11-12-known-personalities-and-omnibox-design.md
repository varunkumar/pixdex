# Known personalities and the search omnibox: design

Date: 2026-11-12. Status: draft for review. Two phases, one document.

## Intent

The owner uses Google Photos today, which recognises famous people without any labelling. PixdeX should do the same
for a curated list of well-known people (Indian first, then global): a photo with Dhoni in it becomes findable by
typing "dhoni" (or "msd", "mahi") with no manual naming.

Search then needs to cope with many more nameable things, so the Search page and the AI Search page are merged into
one omnibox. Album, people, known personalities and dates are chips in one bar, plus an "Ask AI" action. Every
existing capability stays.

## Goals

- Recognise a curated list of known personalities on the owner's machine and surface them in search.
- Typing a name or alias finds them, many at once (AND), in one bar, with a prototype-validated feel.
- Never bloat the People list: only personalities who actually appear in photos the viewer can see are listed or
  suggested.
- Merge Search and AI Search into one page without losing any current behaviour.

## Non-goals

- No photo, thumbnail or embedding leaves the owner's machine for recognition; no cloud celebrity API.
- No promoting a known match into the viewer's own People, no aliases for the viewer's own people (my call).
- No auto-run of the AI model, no multi-album filter, no new result layouts.
- Not a claim of identity: a match is a suggestion that reads "looks like".

## Anti-goals (a failure even if it works)

- A known match overwrites or competes with a `confirmed` or `auto` person assignment on the same face.
- The People page or dropdown gets a long list of people who are not in the library.
- Typing a name silently filters by person (only a clicked chip or a picked dropdown entry filters).
- Existing Search or AI Search URLs or behaviour break.
- Raising Worker CPU or D1 reads on a hot path without saying so.

## Phase 1: known personality recognition

### Gallery (agent, one time and repeatable)

- A curated, committed list of 200 to 500 people (not 1000; the number is open): name, aliases (for example MSD, Mahi,
  SRK, "Captain Cool"), Wikidata id. India first.
- A build script in `agent/` fetches reference photos from Wikidata (portrait) and Wikimedia Commons (the person's
  category and subcategories, openly licensed only), keeps images with exactly one clear face, computes embeddings
  with the existing InsightFace sidecar, drops outliers against the person's median, and stores up to about 10
  embeddings per person in a local, uncommitted file under the agent's state area.
- Target: an average of 5 to 10 usable references per person (owner's requirement). The script prints a report of
  reference counts. People below a minimum (my call: 3) are excluded and listed, so thinly covered famous people are
  visible rather than silently weak.
- Measured on 2026-11-12 (about 46 sample names): 41 resolved by exact English label, 40 of those have a Wikidata
  portrait, and Wikidata alone gives one image each. Commons depth varies from 2 to 126 files per category (Tendulkar
  126, Mohanlal 54, Ganguly 25, Kohli 17, Rohit 4, Shah Rukh Khan 2 in direct files). Reaching the average needs
  subcategory crawling, and some famous names will fall short. Wikidata ids and aliases are needed because several
  people are filed under longer names.
- Licences are enforced at build time (only open licences are used) and only embeddings are stored, so no per-person source
  or licence list is kept. InsightFace weights stay non-commercial,
  personal use.

### Matching (agent)

- The agent already scans faces through the sidecar at ingest and backfill. It additionally compares each face with
  the local gallery and, if it clears the threshold with a margin over the second best person, sends the known id and
  score with that face. Embeddings of the gallery never go to the Worker.
- Thresholds are conservative and tuned on the owner's own library; lookalikes are expected with a few hundred people.
- Existing photos are covered by a backfill command alongside `backfillFaces`.
- Backfill reuses the face embeddings the Worker already stores (decided; no rescan of originals, so no drive needs to
  be mounted). It needs an agent-only Worker read route (INGEST_TOKEN, outside the Pages allowlist) that pages stored
  embeddings (about 100 faces per page, binary rather than base64 JSON, to stay inside the 10 ms CPU budget), and a
  batched write route (`json_each`) that sets known ids only for matched faces. A `--dry-run` prints the match count,
  the score distribution and a sample for review before anything is written, so the threshold is tuned on the real
  library. Estimate for about 5K photos (about 8K faces, about 16 MB): 1 to 3 minutes, versus 30 to 60 minutes if
  originals were rescanned. These are estimates; measure on the real library.

### Worker and storage

- Additive numbered migration: a global `known_people` table (id, display name, aliases, Wikidata id) and a nullable
  known id and score on each face (a face has at most one known match, indexed by known id). Known names are shared
  reference data, not private to an owner. Person-label privacy rules for the viewer's own people are untouched.
- A new ingest route, outside the Pages proxy allowlist, upserts the known list. The ingest face payload gains
  optional known id and score; the Worker validates the id against `known_people` and drops it if unknown.
  `faces.person_id` and `assign_status` rules are unchanged: a known match never sets them.
- Read API: a list of known personalities that appear in photos the viewer can see, with counts (scoped through the
  same album visibility rules as every read); search and timeline accept known ids as an AND filter. Every read stays
  scoped (`scopeFor`) and needs `X-Viewer-Email`.

## Phase 2: the omnibox

### One bar

- Chips in the bar: album (one at a time), people and known personalities (AND, combined maximum 5, my call), and
  dates (the existing typed-date parsing, quick ranges and on-this-day stay). Sort and page size stay as controls.
- Plain search on Enter shows the paginated `PhotoGrid`, as today. "Ask AI" (button or Cmd+Enter, shown only where
  the Chrome Prompt API is supported, as today) shows the ranked cards with the matched, text-space and rating
  footer, capped at 48, as today. The layout follows the mode; the bar and chips are shared.
- AI mode shows its keywords as editable chips (replacing the Keywords box; Enter re-searches without re-running the
  model), keeps the "Hide people photos" and "Leave room for text" options, and keeps the "no matches" and "failed"
  badges.
- Decided with the owner: album, people, known and date chips narrow the AI keyword searches (new; today AI Search
  ignores them). The per-keyword searches pass the same filters to `/search`.
- `/ai-search` keeps working and opens the omnibox in AI mode. The AI search URL uses `people=0` for its switch, which
  collides with `people=<ids>`; rename the AI params in the merged page and keep mapping the old links.

### Suggestion and matching behaviour (validated in a prototype)

- One shared matcher serves both the chip suggestions under the bar and the People dropdown filter. The People box
  has two groups (your people first, then "Known personalities in your photos") and shows when either group is
  non-empty (today it hides with no named people). Your own names rank above known ones on a tie.
- Evaluate as the user types, debounced at 150 ms, minimum 3 characters per span. The lists are fetched once and
  cached, so matching is local and there is no per-keystroke request.
- Case and accent insensitive. Every typed word must start a word of the name or an alias ("dho", "virat k",
  "kohli virat", "msd", "srk"). No fuzzy matching.
- Typed words are split into spans, each naming a different person (longest span wins, a person is never used twice,
  unmatched words stay caption text). "virat dhoni" gives two chips joined by AND plus an "Add both" chip showing the
  real count of photos with both.
- Own people and known personalities are both shown, never merged or hidden, even for the same real person (owner's
  decision). They are told apart by colour on every chip and dropdown entry: your own people in one colour, known
  personalities in another (the prototype used blue and violet). Colour is not the only signal: known entries also
  carry a small "known" marker or icon and the group heading, so it works in both themes and for colour-blind users.
  The same colours apply to the suggestion chips, the picked tags in the bar and the People dropdown rows. Picking
  either kind adds a tag to the bar; removing the tag removes the filter.
- An ambiguous span ("ra") shows at most 3 chips ranked by exact match, name prefix, then photo count, with a
  "+N more" hint.
- Clicking a chip adds the filter and removes just its matched words from the box. Typing alone never filters by
  person.
- Album chips use the same matcher by album name. While an album is chosen, album suggestions are hidden (my call).
- AND can legitimately return zero photos; the "Add both" count makes that visible before clicking.

## Constraints

- Worker free plan: 10 ms CPU per invocation. No loops over embeddings on the Worker for this feature.
- Frontend gating rules in `AGENTS.md` still apply; known names are not hidden by ownership.
- D1 migration must be additive; it is applied automatically on merge before the Worker deploys.
- Never expose tokens to the browser; the new ingest route stays out of the Pages allowlist.
- Update `README.md`, `AGENTS.md` and `docs/` in the same commit as each phase.

## Performance review (mandatory per `AGENTS.md`)

- Worker CPU: no embedding work on the Worker for known matching (done on the agent). Ingest adds one id validation
  per face against a small table (bounded by the batch). The matcher runs in the browser.
- D1: the known list read is one grouped, scoped aggregation per page load (cached client side with a long stale
  time); the builder must confirm its plan with `EXPLAIN QUERY PLAN`, state rows read, and bound it (no unbounded
  scans, no `OFFSET`, no `COUNT(*)` per request). A known filter in `/search` is an indexed lookup on faces joined
  to scoped photos. The "Add both" count is one extra `/search` per shown chip group, only on demand.
- The AI narrowing adds filters to calls that already happen; no extra calls.
- If this cannot be measured locally, measure with `wrangler tail` and `wrangler d1 insights`.

## Decisions made after the builder check (my calls unless noted)

- Phases are separate deliverables: one document, two plans, and README, AGENTS.md and docs updated per phase.
- Phase 1 is usable on its own: it ships a minimal frontend, the known group in the existing People dropdown on
  Search and the known filter. The full omnibox is Phase 2.
- Known matches appear only in search, the timeline filter and the People dropdown. No change to face overlays,
  photo detail or face-naming controls.
- The known filter and counts include every face with a known match, whether or not the face also has a `person_id`.
  The known match is independent of `assign_status`.
- Re-runs: the agent sends the known id, or an explicit null to clear it. A normal backfill only fills faces with no
  known match; a `--rescore` flag overwrites. Ingest is idempotent and the last write wins.
- "Hide people photos" and the old `people=0` meaning are unchanged: it is based on the existing people-photo test
  and known matches do not change it. Old links map losslessly to the renamed param.

## Left to the builder

- Exact table and column names, threshold values and margin, outlier rule, gallery file format, backfill approach.
- Param names for known ids in `/search` and the URL, and the renamed AI search params.
- Component structure for the omnibox and where the shared matcher module lives.
- The exact seed names (at least 200, India first), chosen and verified against Wikidata during implementation.

## Open for the owner

- Nothing blocking. The implementation seeds at least 200 verified people (owner's requirement) and ships a defined process to add more: `known-search`, `known-add`, `known-check`, then an incremental `build-known-gallery` and `backfill-known`, documented in `agent/known/README.md`.
