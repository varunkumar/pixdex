# AI Search: design

Status: draft for owner approval. Nothing here is built yet. A throwaway spike
(`public/spike-occasion.html`, untracked) proved the approach on the real
library; it is deleted when this is built.

## Intent

The owner often needs a photo for a purpose, not a subject: a Diwali greeting to
colleagues, an Xmas wish, a presentation backdrop. The photo does not show the
occasion. It suits it by colour, light, mood and generic nature subjects. Today
the owner scrolls and picks from whatever they remember, biased to recent photos.

AI Search takes a free-form request ("Get me professional photos to use for
Diwali wishes to my colleagues"), has the browser's on-device model turn it into
search keywords, and ranks photos from the whole library against them. It is a
separate page from the existing search, which is unchanged.

## What the spike proved

- Existing stored data (subjects, colours, tags, description, environment) is
  enough. No re-indexing, no embeddings, no new columns.
- Searching all keywords at once fails: common words (golden, sky, bokeh) match
  nearly the whole library (about 3,800 of it for 18 keywords), so results are
  just the top-rated photos for every request. Each keyword must be searched
  separately and weighted by rarity.
- Ranking by how much calm empty room a photo has for overlaid text was the
  feature the owner liked most.

## Goals

- A new page, route `/ai-search`, with a nav entry, that takes a free-form request.
- Keyword expansion by the browser's built-in Prompt API (`LanguageModel`,
  Gemini Nano in Chrome). No server-side model, no paid API, nothing leaves the
  device.
- The page, route and nav entry exist only in browsers where `LanguageModel` is
  present and its availability is not `unavailable`. Elsewhere there is no entry
  and the route redirects to the home page. There is no typed-keywords fallback.
- Keyword expansion rules (prompt): the occasion or purpose name first, with
  alternate names (xmas and christmas), then symbols tied to it (diya, rangoli,
  star, snow), then colour and light words, then generic subjects (flower, sky,
  lake). Single words or two-word phrases. Output is schema-constrained JSON
  (`responseConstraint`) with the regex parse as fallback.
- Ranking: one search per keyword (`GET /api/search?q=<keyword>&sort=rating&limit=100`),
  keyword weight = ln(library size / keyword match count), photo keyword score =
  sum over matched keywords, normalised. Library size comes from an empty
  search's `total`. Then combined with the options below. Initial weights from the
  spike: keyword fit 1.0, empty space 0.6 (when on), rating 0.15. Tunable.
- Options on the page, defaults on: **Hide people photos** and **Leave room for
  text**. Both can be turned off. Further options may be added later.
- Transparency: each result shows which keywords matched it, its text-space
  percentage and side (top, bottom, left, right), and its rating. The page shows
  the generated keyword list, editable, with a "search again" using the edited
  list without re-running the model. A visible progress state while the model
  runs (model download progress on first use, a busy indicator, elapsed time).
- Results link to the existing photo detail page.

## Non-goals

- No changes to the Worker, D1, the agent or any migration. The first version is
  frontend only.
- No embeddings, vector store or Workers AI.
- No saving of requests or results, no history, no sharing.
- No server-side or cloud fallback for browsers without the Prompt API.
- No changes to the existing `/search` page.

## Anti-goals (failure even if it technically works)

- Results that are the same top-rated photos regardless of the request.
- A feature that silently does nothing: the user must always be able to see
  whether the on-device model ran and what it produced.
- Sending photos, thumbnails or the request text to any third party.

## Constraints

- Frontend: React 19, Vite, Mantine, react-query, as the rest of `src/`.
- Reads go through the existing same-origin `/api/search` proxy, which already
  allows `GET search`. No new proxy allowlist entries. `READ_TOKEN` never reaches
  the browser.
- Owner edits and ranking rules in `AGENTS.md` still apply; the aesthetic nudge
  should use the combined score semantics (`worker/src/db/rating.ts`), not read
  `aesthetic_score` as the only truth. The search response already carries the
  effective rating field the spike used (`aestheticScore`); the builder confirms
  which field is the combined one.
- Empty-space measurement is client side: load the thumbnail via the existing
  thumbnails URL, draw it to a 48 by 48 canvas, compute edge density in the top,
  bottom, left and right 40 percent bands; the calmest band's score is
  `max(0, 1 - meanEdge / 25)`. The constant 25 is a rough guess from the spike
  and should be easy to tune. Measure only the top 150 photos by keyword score,
  and cache results per photo id for the session.
- "Hide people" uses stored subjects and tags matching a people word list
  (person, people, man, woman, child, portrait, group, family, couple and
  similar), as the spike did. It is imperfect (a distant figure can slip
  through). Using the faces data is a possible later improvement.
- README.md and AGENTS.md are updated in the same commit as the feature, and
  `docs/` if architecture changes (a short mention in `docs/architecture.md`).
- Pre-commit hook must pass; do not bypass.

## Decisions made by the owner

- Name: "AI Search". Separate page from current search.
- Enabled only on browsers with the local Prompt API.
- Free-form requests, with options for text spacing and hiding people.
- Chrome with the Prompt API flags is the target; this is a personal tool.

## Calls made by the author (change if you disagree)

- Frontend only, per-keyword requests from the browser (about 18 parallel
  requests per search) rather than a new Worker endpoint.
- Weights and the edge-density threshold as in the spike.
- People hiding from tags, not faces.
- Expansion prompt and one worked example (Xmas) as in the spike; the builder
  may tune wording.

### Pipeline and edge cases (author's calls)

- Order: per-keyword searches (limit 100 each, sorted by rating) -> union and
  keyword score -> drop people photos (if on) -> keep the top 150 by keyword
  score -> measure empty space -> final rank -> show the top 48. No paging. If
  fewer than 48 survive, show fewer.
- Per-keyword results are capped at the 100 best-rated matches while the weight
  uses the keyword's full match count. The bias toward highly rated photos is
  intended (the owner wants professional-looking photos). A photo matches a
  keyword only if it is in that keyword's returned set.
- Keywords with 0 matches are skipped and listed as "no matches" next to the
  keyword list. A keyword matching the whole library has weight 0 and is
  harmless. If no photos are found, show an empty state that suggests editing
  the keywords.
- Normalisation: keyword score divided by the maximum in the candidate set (0 to
  1); empty space is already 0 to 1; rating is divided by 10. Final rank =
  keyword + 0.6 * space (if on) + 0.15 * rating.
- Model states: `downloadable` and `downloading` count as supported (show the
  page and the download progress). If the model errors or returns unparseable
  output on a supported browser, show the error and leave the keyword box
  editable and empty so the owner can type keywords and search anyway. This is
  an error path, not an unsupported-browser fallback.
- State: keep the request, keywords and options in the URL query string, so
  returning from a photo page restores the page and reruns the cheap keyword
  search without calling the model again.
- Search results already include subjects, tags, colours and the rating, and
  thumbnails are served same-origin through `/api/thumbnails`, so canvas
  measuring needs no proxy or Worker change.

## Left to the builder

- Component and file structure, hook design, tests (mock `LanguageModel`, mock
  canvas measurement).
- Page layout and visual design within the existing Mantine look.
- How to detect Prompt API support cleanly (feature check, availability call,
  whether to hide the nav entry before the async availability resolves).
- Whether to batch or cap the per-keyword requests.
