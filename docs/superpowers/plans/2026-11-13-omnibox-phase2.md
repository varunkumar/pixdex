# Omnibox (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge Search and AI Search (`/ai-search`) into one omnibox page where album, people, known personalities and dates are chips in one bar, with an "Ask AI" action, and every existing capability kept.

**Architecture:** Frontend only. A pure matcher module (extending `personMatch.ts`) splits typed text into spans and ranks candidates; an `Omnibox` component renders chips, the input and a suggestion panel; `Search.tsx` becomes the single page with a plain mode (paginated `PhotoGrid`) and an AI mode (ranked cards). The AI pipeline gains the same filters the plain search uses. `/ai-search` becomes a redirect that maps old params losslessly. No Worker, D1, agent or Pages Function change.

**Tech Stack:** React 19, Vite, Mantine 9 (`@mantine/hooks` `useDebouncedValue`), TanStack Query, react-router-dom 7, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-12-known-personalities-and-omnibox-design.md` (Phase 2, Goals, Anti-goals, Constraints, Performance review, "Decisions made after the builder check").

## Global Constraints

- Never use em dashes anywhere (code, docs, commits, PR text). Pre-commit hook is never bypassed.
- Do not commit `.env`, `credentials/`, `agent/.index-state/`. Do not run `backfill-known`. Do not change Phase 1 matching or thresholds.
- Typed words become chips via the shared matcher: debounce 150 ms, minimum 3 characters per span, each typed word matches anywhere inside a name or alias word, case and accent insensitive, no fuzzy matching, longest span wins, a person never used twice, at most 3 ambiguous chips plus "+N more", "Add both" chip with the real photo count, typing alone never filters.
- Combined people + known cap is 5 (`MAX_PEOPLE_FILTER`). Album is one at a time; album suggestions hidden while an album is chosen.
- Own people blue, known violet plus a "known" marker and the group heading (colour never the only signal). Own ranks above known on ties.
- Frontend gating: hidden, never disabled. No `VITE_` secrets. Avatars/people rules in AGENTS.md untouched.
- Lists (`['people']`, `['known-people']`, `['album-names']`) are fetched once and cached (staleTime 5 minutes), matching is local, no per-keystroke request.
- `README.md`, `AGENTS.md`, `docs/architecture.md` updated in the same commit as the change they describe.
- Use plain, separate git commands. Work in a worktree under `.claude/worktrees/omnibox-phase2`. One PR, the owner merges.

## Rulings (spec vs current code)

1. **AI param rename.** Old `people=0` (show people photos) becomes `hidePeople=0`. `room=0` and `kw` are unchanged (no collision). New `mode=ai` selects AI mode. `/ai-search` redirects (replace) to `/search` with `mode=ai`; on `/ai-search` any `people` value other than exactly `0` was ignored by the old page, so it is dropped, and exactly `0` maps to `hidePeople=0`. `q`, `kw`, `room` carry over.
2. **Unsupported browser on `/ai-search`.** Today redirects home. Now redirects to `/search` (AI params dropped), since the merged page is the destination. On `/search?mode=ai` without support, `mode`, `kw`, `hidePeople`, `room` are stripped the same way.
3. **Nav.** The "AI Search" nav link is removed (the page is Search). `usePromptApiSupport` stays and gates "Ask AI".
4. **Same box, two meanings.** `q` is the plain search text in plain mode and the natural-language request in AI mode (as the old page). Enter runs plain search (clears `mode` and `kw`); "Ask AI" / Cmd+Enter runs the model and sets `mode=ai`, `q`, `kw`. Typed-date parsing applies on Enter only, never to an AI request.
5. **Hide people photos vs person chips.** Filtering by a person while hiding people photos is contradictory. When any people or known chip is active, the switch is hidden and the pipeline uses `hidePeople: false`. The URL value is kept for when the chips go.
6. **Library total in AI ranking.** Rarity weight is `log(libraryTotal / keywordTotal)`. With filters, the library total call receives the same filters so weights stay relative to the narrowed set. Still exactly the same number of calls.
7. **Browse without typing.** Spec keeps "empty box lists everyone" (today's People behaviour). The suggestion panel shows the full lists (own, known, albums) when the input is focused and empty, and the matched lists from 3 characters. `PeopleFilter` stays for Timeline, unchanged in behaviour; it only imports shared colour constants.
8. **"Add both" scope and timing.** Count = `/search` with `limit=1` over the top candidates of each span plus the already active album, people, known and date chips, excluding unsubmitted text. Fires once after the debounce when the chip is shown (cached by key), never per keystroke. If adding both would exceed the cap of 5, the chip is not shown.
9. **Dates in the bar.** A date range (or quick range or on-this-day) shows as one removable chip in the bar; the date picker and quick chips stay as controls in the row below, as today.

## Review Focus

1. Typed "ra" or any 1 to 2 character span: no chips, no request, box unchanged.
2. Accents and case: "ÉSH", "Ganesh", "esh", "A. R. Rahman" typed as "ar rahman" all match as today.
3. Same real person as own and known: both chips shown, never merged, each coloured correctly.
4. Cap overflow: 5 chips active, then clicking a suggestion or "Add both" adds nothing and no chip offered beyond the cap.
5. Old links: `/ai-search?q=x&kw=a,b&people=0&room=0` lands on `/search?mode=ai&q=x&kw=a,b&hidePeople=0&room=0`; a `/search?people=<id>` link still means people ids.

## File Structure

- Create `src/services/omnibox/matcher.ts`: pure matching (`rankMatches`, `splitSpans`), uses `personMatch.ts`.
- Create `src/services/omnibox/urlState.ts`: omnibox URL parse and legacy AI mapping.
- Create `src/components/chipStyle.ts`: `OWN_COLOR`, `KNOWN_COLOR`, `ALBUM_COLOR` shared by `PeopleFilter` and the omnibox.
- Create `src/hooks/useOmniboxData.ts`: cached lists plus debounced suggestions plus "Add both" count.
- Create `src/components/omnibox/Omnibox.tsx` (bar, chips, input, Ask AI) and `SuggestionPanel.tsx`.
- Modify `src/components/Search.tsx` (merged page, both modes), `src/services/aiSearch/pipeline.ts` (filters), `src/components/PeopleFilter.tsx` (import colours), `src/App.tsx` (route), `src/components/Layout.tsx` (nav).
- Create `src/components/AiResults.tsx` (moved `ResultFooter`, cards, badges) and delete `src/components/AiSearch.tsx` after its content moves.
- Create `dev/mockApi.ts` and edit `vite.config.ts`: dev-only mock API (`PIXDEX_MOCK=1`) with dummy data for the browser check.

---

### Task 1: Shared matcher and span splitter

**Files:**
- Create: `src/services/omnibox/matcher.ts`
- Test: `src/services/omnibox/__tests__/matcher.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type CandidateKind = 'own' | 'known' | 'album';
  export interface Candidate { kind: CandidateKind; id: string; label: string; aliases: string[]; photoCount: number }
  export interface Span { start: number; end: number; words: string; matches: Candidate[] } // start/end are word indexes, end exclusive; matches ranked
  export function rankMatches(query: string, candidates: Candidate[]): Candidate[]
  export function splitSpans(text: string, candidates: Candidate[], excludeIds?: Set<string>): { spans: Span[]; maxWords: 12 }
  export function removeWords(text: string, spans: Span[]): string // text with those spans' words removed, single spaced
  ```
  Candidate key for "never twice" and `excludeIds` is `` `${kind}:${id}` ``.
- Consumes: `matchesQuery`, `normalizeName` from `src/services/personMatch.ts` (reuse, do not rewrite).

- [ ] **Step 1: Write failing tests** covering: `rankMatches('dho', [Dhoni(known, aliases ['MSD','Mahi']), ...])` returns Dhoni; `'esh'` finds "Ganesh"; `'msd'` and `'srk'` match by alias; `'ra'` returns `[]`; accents/case (`'ÉSH'`); ranking order exact match, then name prefix, then `photoCount` desc, then own before known on a full tie; `splitSpans('virat k', ...)` gives one span `virat k` matching Virat Kohli; `'kohli virat'` one span; `'virat dhoni'` two spans, each one match; longest span wins (`'virat kohli'` is one span, not two); a candidate used by an earlier span is excluded from later spans (`'ra ra'` style: use two spans that would both match the same single candidate, the second gets none); unmatched words are not in any span; input over 12 words only evaluates the first 12; `removeWords('virat dhoni caption', [span0])` returns `'dhoni caption'`; an own and a known candidate for the same real name both appear in `matches`.
- [ ] **Step 2: Run** `npx vitest run src/services/omnibox/__tests__/matcher.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the module. `rankMatches` filters with `matchesQuery(query, [label, ...aliases], 3)`, sorted by a three-level key (exact normalized equality with any name or alias; normalized prefix of label or alias; photoCount) then own-before-known, stable. `splitSpans` tokenises on whitespace (first 12 words), scans left to right, for each start takes the longest `end` for which `rankMatches(words, unused)` is non-empty (spans of one word under 3 normalized characters never match because `matchesQuery` enforces the minimum), consumes it, marks only the span's top match as used (the "+N more" alternatives stay available to the panel, not to later spans). Cost: O(words^2 x candidates) with words at most 12, a few hundred candidates, local.
- [ ] **Step 4: Run** the test file. Expected: PASS. Also `npx vitest run src/services/__tests__/personMatch.test.ts` still passes.
- [ ] **Step 5: Commit** `feat(omnibox): shared matcher and span splitter`.

### Task 2: URL state and legacy AI mapping

**Files:**
- Create: `src/services/omnibox/urlState.ts`
- Test: `src/services/omnibox/__tests__/urlState.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface OmniboxState { mode: 'plain' | 'ai'; q: string; kw: string; hidePeople: boolean; leaveRoom: boolean }
  export function readOmniboxState(params: URLSearchParams): OmniboxState // mode=ai only when params.get('mode') === 'ai'
  export function mapLegacyAiParams(search: string): string // query string for /search, no leading "?"
  export function stripAiParams(params: URLSearchParams): URLSearchParams // removes mode, kw, hidePeople, room
  ```
- Consumes: `parsePeopleSelection` (unchanged).

- [ ] **Step 1: Write failing tests**: `mapLegacyAiParams('q=x&kw=a,b&people=0&room=0')` equals `mode=ai&q=x&kw=a%2Cb&hidePeople=0&room=0` (compare as parsed `URLSearchParams` entries); `people=5` on legacy is dropped (not turned into a filter); empty input gives `mode=ai`; `readOmniboxState` defaults `hidePeople` true and `leaveRoom` true, false only for the exact value `'0'`; `stripAiParams` keeps `q`, `people`, `known`, `album`, dates.
- [ ] **Step 2: Run** the file, expect FAIL.
- [ ] **Step 3: Implement** both functions plus `readOmniboxState` as above (pure, no React).
- [ ] **Step 4: Run** the file, expect PASS.
- [ ] **Step 5: Commit** `feat(omnibox): URL state and lossless legacy AI param mapping`.

### Task 3: AI keyword searches honour the filters

**Files:**
- Modify: `src/services/aiSearch/pipeline.ts` (`runAiSearch` signature, calls at lines 44 and 46)
- Test: `src/services/aiSearch/__tests__/pipeline.test.ts`

**Interfaces:**
- Produces: `export interface AiFilters { album?: string; people?: string[]; known?: string[]; from?: string; to?: string; onThisDay?: string }` and `runAiSearch(terms: string[], options: AiSearchOptions, measure?, filters?: AiFilters)` (filters as the 4th optional parameter so existing callers and tests keep working).
- Consumes: `SearchParams` fields from `WorkerApiClient`.

- [ ] **Step 1: Write failing tests**: with filters `{ album: 'Trip', known: ['Q1'], from: '2025-01-01', to: '2025-01-31' }` each per-keyword `searchPage` call receives `{ q: term, sort: 'rating', limit: 100, ...filters }` and the library total call receives `{ limit: 1, ...filters }`; call count is unchanged (terms.length + 1); with no filters the calls are exactly as today (existing tests stay green); empty arrays and empty strings are not forwarded.
- [ ] **Step 2: Run** `npx vitest run src/services/aiSearch/__tests__/pipeline.test.ts`, expect the new tests FAIL.
- [ ] **Step 3: Implement** by spreading a cleaned filters object into both calls (drop empty values).
- [ ] **Step 4: Run** the file, expect PASS.
- [ ] **Step 5: Commit** `feat(ai-search): narrow keyword searches by album, people, known and dates`.

### Task 4: Omnibox data hook (lists, debounce, Add both count)

**Files:**
- Create: `src/components/chipStyle.ts`, `src/hooks/useOmniboxData.ts`
- Modify: `src/components/PeopleFilter.tsx` (import colours from `chipStyle.ts`, no other change)
- Test: `src/hooks/__tests__/useOmniboxData.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  // chipStyle.ts
  export const OWN_COLOR = 'blue'; export const KNOWN_COLOR = 'violet'; export const ALBUM_COLOR = 'teal';
  // useOmniboxData.ts
  export interface OmniboxSelection { album: string; people: string[]; known: string[]; from: string; to: string; onThisDay: string }
  export function useOmniboxData(text: string, selection: OmniboxSelection): {
    candidates: Candidate[];          // own (label via personOptions), known (name + aliases), albums; already-selected ones excluded; albums omitted while selection.album is set
    labelFor: (kind: CandidateKind, id: string) => string | null;  // for chips of selected items
    spans: Span[];                    // from the debounced text (150 ms, useDebouncedValue)
    bothCount: { ids: Candidate[]; total: number | null } | null; // null when fewer than 2 person spans or cap exceeded
    listsLoaded: { people: boolean; known: boolean; albums: boolean };
  }
  ```
- Consumes: Task 1 (`splitSpans`, `Candidate`), `personOptions`, `workerApiClient.getPeople/getKnownPeople/getAlbums/searchPage`, `MAX_PEOPLE_FILTER`.

- [ ] **Step 1: Write failing tests** (mock `workerApiClient`, fake timers): the three list queries fire once for several text changes (assert call counts); spans are empty until 150 ms after the last keystroke and for text under 3 characters; typing alone makes no `searchPage` call; `bothCount` fires exactly one `searchPage({ people|known..., album, from, to, onThisDay, limit: 1 })` when two person spans are shown and returns its `total`, and not when it would exceed 5; albums omitted when an album is selected; own and known entries for the same name both appear.
- [ ] **Step 2: Run** the test file, expect FAIL.
- [ ] **Step 3: Implement** the hook with `useQuery` (staleTime 5 minutes, same keys `['people']`, `['known-people']`, `['album-names']` so caches are shared with Timeline) and a `useQuery(['omnibox-both', ids, selection], staleTime: 5 min, enabled: bothShown)` for the count.
- [ ] **Step 4: Run** the file plus `npx vitest run src/components/__tests__/PeopleFilter.test.tsx`, expect PASS.
- [ ] **Step 5: Commit** `feat(omnibox): cached lists, debounced spans and Add both count`.

### Task 5: Omnibox bar and suggestion panel

**Files:**
- Create: `src/components/omnibox/Omnibox.tsx`, `src/components/omnibox/SuggestionPanel.tsx`
- Test: `src/components/omnibox/__tests__/Omnibox.test.tsx`

**Interfaces:**
- Produces:
  ```tsx
  export interface OmniboxProps {
    text: string; onText: (t: string) => void;
    selection: OmniboxSelection;
    onSelection: (patch: Partial<OmniboxSelection>) => void;   // one call per change, e.g. { people: [...] }
    onSubmit: () => void;            // Enter
    onAskAi?: () => void;            // present only where the Prompt API is supported; Cmd/Ctrl+Enter
    askAiBusy?: boolean;
    keywordChips?: { terms: string[]; onChange: (terms: string[]) => void; onSearchAgain: () => void }; // AI mode only
  }
  export default function Omnibox(props: OmniboxProps): JSX.Element
  ```
- Consumes: Task 4 hook, Task 1 `removeWords`, `chipStyle.ts`, `MAX_PEOPLE_FILTER`.

- [ ] **Step 1: Write failing tests**: renders chips for the selection (own blue, known violet with a "known" marker and a visually hidden "(known personality)" label, album, one date chip) each removable; typing "dho" does not call `onSelection` (typing alone never filters); after the debounce a chip "Dhoni" appears, clicking it calls `onSelection({ known: [...] })` and `onText` with only its words removed; "virat dhoni" shows two chips and "Add both (N photos)" with the mocked count, clicking adds both and removes both spans' words; ambiguous span shows 3 chips and "+2 more"; with 5 selected, no chips offered; album suggestions hidden while an album chip exists; empty focused input lists own, known and albums groups with headings; "Ask AI" button and Cmd+Enter exist only when `onAskAi` is passed; Enter calls `onSubmit`; with `keywordChips`, each keyword is an editable removable chip and Enter in the keyword input calls `onSearchAgain`.
- [ ] **Step 2: Run** the file, expect FAIL.
- [ ] **Step 3: Implement** with Mantine `PillsInput`/`Pill` for the bar and `Popover` for the panel (aria roles: combobox/listbox, keyboard up/down/enter). Chip colours via `var(--mantine-color-<color>-light)` and `-light-color`, same as `PeopleFilter.renderPill`, so both themes work. Hidden, never disabled, for Ask AI when unsupported.
- [ ] **Step 4: Run** the file, expect PASS.
- [ ] **Step 5: Commit** `feat(omnibox): chip bar with suggestions and Ask AI`.

### Task 6: Merged Search page (plain and AI modes), route, nav

**Files:**
- Modify: `src/components/Search.tsx`, `src/App.tsx:41-46`, `src/components/Layout.tsx:39,78`
- Create: `src/components/AiResults.tsx` (move `ResultFooter`, the grid of `PhotoCard`, "people photos hidden", "no matches" and "failed" badges from `AiSearch.tsx`)
- Delete: `src/components/AiSearch.tsx` and `src/components/__tests__/AiSearch.test.tsx` (their cases move into `Search.test.tsx`)
- Test: `src/components/__tests__/Search.test.tsx`, `src/components/__tests__/Layout.test.tsx`

**Interfaces:**
- Consumes: Tasks 2 to 5, `expandRequest`, `runAiSearch(terms, { hidePeople, leaveRoom }, undefined, filters)`, `usePromptApiSupport`, `useListParams`.
- Produces: route `/ai-search` element `<LegacyAiRedirect />` using `mapLegacyAiParams` with `Navigate replace`.

- [ ] **Step 1: Write failing tests** (port the existing Search and AiSearch cases, add): plain Enter shows the paginated `PhotoGrid` exactly as today (all existing Search tests stay green, including typed-date parsing and quick chips); album/people/known/date chips come from and write to the URL (`album`, `people`, `known`, `from`, `to`, `onThisDay`); "Ask AI" runs `expandRequest`, then sets `mode=ai&q&kw`, shows ranked cards capped at 48 with matched, text-space and rating footer; keyword chip edit then Enter re-searches without calling `expandRequest`; "Hide people photos" and "Leave room for text" switches write `hidePeople=0` and `room=0`; `runAiSearch` receives the active filters; with a person chip active the hide switch is not rendered and `hidePeople: false` is passed; "no matches" and "failed" badges show; `/ai-search?q=x&kw=a,b&people=0&room=0` navigates to `/search?...mode=ai...hidePeople=0&room=0`; unsupported browser: `/ai-search` and `/search?mode=ai` land on `/search` without AI params and no "Ask AI" control exists; Layout test: no "AI Search" link in either support state.
- [ ] **Step 2: Run** `npx vitest run src/components/__tests__/Search.test.tsx src/components/__tests__/Layout.test.tsx`, expect FAIL.
- [ ] **Step 3: Implement** `Search.tsx`: URL is the source of truth (as today), local `text` synced from `q`; Enter: `update({ q: parsed.text, ...dates, mode: null, kw: null }, { resetPage: true })`; Ask AI: expansion mutation, `onSuccess` updates `mode: 'ai', q, kw`; layout follows `mode`; sort and page size controls stay (page size and pagination only in plain mode). Remove the standalone Album Select and PeopleFilter from `Search.tsx` (now chips); keep the date picker row and quick chips. `Layout.tsx`: drop `AI_SEARCH_LINK` and the support check.
- [ ] **Step 4: Run** the two files plus `npx vitest run` for the whole root suite, `npm run lint`, `npm run build`; expect all PASS.
- [ ] **Step 5: Commit** `feat: merge Search and AI Search into one omnibox page`.

### Task 7: Dev mock API and browser verification

**Files:**
- Create: `dev/mockApi.ts`; Modify: `vite.config.ts` (a plugin enabled only when `PIXDEX_MOCK=1`, before the `/api` proxy takes effect)

**Interfaces:**
- Produces: dummy responses for `GET /api/me`, `/people`, `/people/known` (at least 6 known entries with aliases and counts, including one sharing a name with an own person), `/albums`, `/search` (gradient placeholder thumbnails, honours `limit=1` totals), `/timeline*` empty. Dummy names only, no real photos or real people from the owner's library.

- [ ] **Step 1: Implement** the mock plugin (dev only, never imported by the production build; confirm `npm run build` output has no mock code).
- [ ] **Step 2: Run** `PIXDEX_MOCK=1 npm run dev` and, with the Chrome DevTools MCP, check light and dark: chip colours (own blue, known violet, known marker), panel, "Add both" count, "+N more", AI mode (the Prompt API is absent in the test browser, so also verify "Ask AI" is hidden there and AI mode renders from `?mode=ai&kw=a,b`), mobile width 390 px. Record the results (and the People box colours on Timeline, still unchecked from Phase 1) in the PR description. No screenshots committed.
- [ ] **Step 3: Fix** any contrast or layout issue found, re-run the affected tests.
- [ ] **Step 4: Commit** `chore(dev): mock API for browser checks of the omnibox`.

### Task 8: Docs and performance statement

**Files:**
- Modify: `README.md` (Search section, the "AI Search" section: new URL params, merged page, old links), `AGENTS.md` (Layout bullet for `/ai-search`, Frontend People filter bullet, Known personalities UI status), `docs/architecture.md` (lines about Search and AI Search, URL state), `docs/development.md` (dev mock command and how to measure)

- [ ] **Step 1: Update** each file (no em dashes). AGENTS.md: the omnibox files, params (`mode=ai`, `kw`, `hidePeople=0`, `room=0`), the rulings that are rules (hide-people switch hidden with person chips; library total gets filters; `/ai-search` is a redirect), and the browser-verified status.
- [ ] **Step 2: Run** `git diff main --name-only`, then grep the added lines for U+2014 with `git diff main | grep -n $'\xe2\x80\x94'` (expect no output).
- [ ] **Step 3: Run** all suites: `npm test`, `npm run lint`, `npm run build`, `cd worker && npm test && npm run typecheck`, `cd agent && npm test && npm run typecheck` (the last two only to confirm nothing moved; no changes expected there). Expect PASS.
- [ ] **Step 4: Run** `graphify update .`.
- [ ] **Step 5: Commit** `docs: omnibox (Phase 2)`, then push the branch and open one PR (description: summary, rulings, the performance review below, browser check results, how to measure; end with the Claude Code line).

---

## Performance review (Worker CPU and D1)

No Worker, D1, migration, agent or Pages Function change, so Worker CPU per invocation is unchanged (no new loops, JSON, or decoding there). The matcher runs in the browser: at most 12 words x a few hundred names, after a 150 ms debounce.

Requests, all existing read routes, all scoped by `X-Viewer-Email` and `scopeFor` as today:

| Request | When | Rows (existing plans, unchanged) |
| --- | --- | --- |
| `GET /people`, `GET /people/known`, `GET /albums` | once per page load, cached 5 minutes, shared with Timeline (same query keys) | as today; Search previously did the same three loads |
| `GET /search?...&limit=1` ("Add both" count) | once per shown "Add both" chip group after the debounce, cached by ids and filters, never per keystroke, only when two person spans are shown | one indexed filtered count; `known` uses `idx_faces_known_photo`, `people` the existing faces join; no `OFFSET`, no `COUNT(*)` beyond the existing `total` it already returns |
| AI keyword `GET /search` calls | same count as today (one per keyword plus one library total) | each now also carries the active filters, which only narrows the scans |

The worker's `EXPLAIN QUERY PLAN` for `/search` with `known` and `people` was covered in Phase 1; this plan adds no new query shape, only reuses it with `limit=1`, so the builder re-runs `EXPLAIN QUERY PLAN` on the exact `limit=1` + album + known + people + dates combination in `worker/` (read only, local D1) and records the output in the PR. Not measurable locally: real D1 rows read and Worker CPU for the count request. Measure after deploy with `cd worker && npx wrangler tail` (CPU time per `/search` while typing two names) and `npx wrangler d1 insights DB`. The change adds no cost to a hot path beyond that on-demand count; nothing to warn the owner about beforehand.

## Self-review notes

- Spec coverage: one bar and chips (T5, T6), plain/AI modes and Ask AI gating (T6), AI keywords as chips, options and badges (T5, T6), narrowing (T3, T6), `/ai-search` and renamed params (T2, T6), matcher rules (T1), colours and markers (T4, T5), cap and album rules (T4, T5), Add both (T4, T5), perf (this section), docs (T8), browser check (T7).
- Types: `Candidate`, `Span`, `OmniboxSelection`, `AiFilters` are defined once and reused by name in later tasks.
