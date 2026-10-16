# Image vectors, similar photos and people: design

Status: draft for owner approval. Nothing here is built yet.

## Intent

PixdeX search is text only (D1 FTS5 over what the vision model wrote). Two
things text cannot do well:

1. "Show me photos that look like this one."
2. "Show me every photo of this person", and "Person 1 and Person 2 together".

Both need vectors computed from pixels. This design adds them with no vector
store, no Workers AI and no paid Cloudflare feature: the local agent computes
vectors and pushes them to D1, and the Worker scores them on demand, on a
bounded candidate set.

## Goals

- **Find similar** photos, behind a button on the photo page, computed on
  demand, never against more than 1,000 candidates, with filters (text, tags,
  subjects, album, date, rating) that narrow the candidates first.
- **People**: the owner names a face once and the matching attaches that name to
  the same person in other photos. Naming works both by clicking a face inside a
  photo and from a People page of unnamed groups.
- **Correcting wrong matches** is a first-class action, and a correction is
  never overwritten by later matching.
- "Person A and Person B together" is a filter on the search and album pages.
- Works from desktop and mobile (the browser only talks to the Worker).

## Non-goals

- No Cloudflare Vectorize, Workers AI, Queues or any paid feature.
- No vectors shipped to the browser.
- No text-to-image search over the image vectors yet. Typing a query against
  image vectors needs the query embedded by the same model, which means a
  local service behind the tunnel. Deferred ("layer 2"). Text search stays on
  FTS5.
- No pixel-based colour or background analysis (separate, deferred).
- No whole-person detection (YOLO) or segmentation (SAM). Face-less people
  are out of scope.
- Originals never leave local disk or Google Drive. Unchanged.

## Anti-goals

- A wrong auto-match that the owner cannot undo or that comes back after being
  undone.
- Embeddings or face crops reaching the browser.
- Matching quality that silently degrades because a different model produced
  some of the vectors.

## Evidence (spike, 2026-10-16)

Throwaway scripts, not in the repo, run on a Mac Studio M1 Max with the Qwen
captioner already running. 50 Bandipur photos plus 8 from "Aganvee 3 Photoshoot".

- **SigLIP 2 Base (`ViT-B-16-SigLIP2-256`, open_clip, 768-d):** about 14 ms per
  image on the GPU after a 14 s one-time load. Visually checked: "big cat
  sleeping on a tree" returned three leopard-in-tree frames, "elephant" returned
  only elephants, similar-photo neighbours were the same scene. Weak on colour
  and background words, as expected.
- **InsightFace `buffalo_l` (SCRFD + ArcFace, 512-d):** about 0.27 s per photo.
  17 faces in 16 photos, no false faces on wildlife. The same adult across 15
  faces scored 0.50 to 0.94 against each other; a different person scored 0.2.
- **Age test:** a child at about 3 (7 faces) against the same child at about 6
  with glasses (2 faces) scored 0.43 to 0.56. The child never matched the adult
  (0.11 to 0.17). Conclusion: one reference face is not enough for a child, the
  suggestion floor must sit below the auto-attach threshold, and every confirmed
  face widens coverage.
- Models and licences to re-verify before building: SigLIP 2 checkpoints are
  listed as Apache-2.0 by third parties (check the official card). InsightFace
  pretrained weights are non-commercial, which is fine for a personal library.

## Constraints

- Cloudflare **free tier only**. Free Workers have a small per-request CPU
  budget (believed to be about 10 ms, **to be re-measured, not assumed**) and
  D1 has daily rows-read and storage quotas. The design bounds the work per
  request instead of relying on the exact numbers.
- Pages proxy rules from `AGENTS.md` stay: `/ingest/*` is not exposed to the
  browser, no secret reaches the bundle.
- Owner decisions are never overwritten by the agent or ingest routes (same
  rule as `user_*`).
- Migrations are additive (they auto-apply on merge before the new Worker
  goes live). Mirror each in `worker/migrations/index.ts`.
- The agent is Node/TS on the owner's Mac. Python is needed only for the
  embedding sidecar.

## Decisions made by the owner

- D1 stores the vectors, and similarity is computed on demand by the Worker.
  No vector database.
- Similar photos are on demand behind a button. Each request scores at most
  **1,000** candidate photos, and the user can filter by tags or other text
  fields to choose them. This is a design rule from day one.
- Face matching is on demand, with a way to correct wrong matches.
- Naming works both ways: click a face in a photo, and a People page of groups.
- Face recognition is a primary feature alongside find-similar.

## Design

### Data model (two migrations, both additive)

`0009_image_embeddings.sql`

- `photos.image_embedding BLOB` (768 float32, 3 KB) and
  `photos.image_embedding_model TEXT` (e.g. `siglip2-b16-256`). Scoring only
  compares vectors with the same model value, so a model swap means re-embedding
  and nothing silently mixes.

`0010_people.sql`

- `persons(id, name, created_at)`. Names are the owner's text.
- `faces(id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, det_score, embedding BLOB,
  embedding_model, person_id NULL, assign_status, match_score, created_at)`.
  `assign_status` is one of `unassigned`, `auto`, `confirmed`. Only the owner
  (browser writes) sets `confirmed`. The agent only inserts rows with
  `unassigned` and never writes `person_id` or `assign_status`.
- `face_rejections(face_id, person_id)` primary key on the pair: "this face is
  not that person". Persisted so a correction survives re-matching.
- Indexes on `faces(photo_id)`, `faces(person_id)`, `faces(assign_status)`.

`confirmed` faces are the only reference vectors for a person. `auto` matches
never become references (no drift). Confirming an `auto` match upgrades it to a
reference. Face bounding boxes are stored so the UI can draw them over the
thumbnail and crop face tiles without sending embeddings.

### Agent

- `agent/sidecar/` (Python, `open_clip` for SigLIP 2, `insightface` for faces),
  a small local HTTP or stdio service. The Node agent sends it an image and
  receives the image vector plus detected faces (bbox, score, vector). Qwen
  captioning stays in Ollama, unchanged.
- Embedding runs in the same pass as captioning, from the same resized image,
  so each photo is read and decoded once. Face detection needs more pixels than
  a small thumbnail (the spike used 1280 px); builder to confirm the working
  size.
- New CLI command `backfill-vectors <folder>` (resumable, like `backfill-exif`)
  for the existing library. `index-batch` and `index-local` call the same code
  for new photos.
- New ingest routes: `POST /ingest/embedding` and `POST /ingest/faces`, behind
  `INGEST_TOKEN`, not in the Pages allowlist. Re-ingest of a photo replaces its
  `unassigned` and `auto` faces but never deletes or edits `confirmed` ones.

### Worker: similar photos

`GET /photos/:id/similar` with optional filters: `q` (FTS text, reuses the
tiered query expansion), `tags`, `subjects`, `album`, `from`/`to` (capture
date), `min_rating`, and `limit` (default 24).

- The Worker builds the **candidate set** with a normal SQL query (FTS and
  column filters), then **caps it at 1,000**, then loads those rows' vectors and
  scores them against the query photo by cosine similarity (vectors are
  L2-normalised, so it is a dot product).
- Cap rule when there are more than 1,000 candidates: with `q`, keep the best
  1,000 by bm25. Without `q`, keep the 1,000 closest in capture time to the
  query photo, same album first (**builder-level call by the designer**, see
  below).
- The response includes `candidate_count`, `scored_count` and `capped: true`
  when the cap applied, so the UI can say "searched 1,000 of 4,320 matching
  photos, narrow with a filter to see more". Excludes the query photo itself.
- The scorer lives in one shared module so thresholds and the cap are in one
  place (`worker/src/search/similarity.ts`).

### Worker: people

All read routes need `READ_TOKEN` and go in the Pages allowlist. The browser
writes (name, assign, reject) are added to the proxy's forwarded writes next to
`PUT albums/cover` and `PATCH photos/:id`. **That list in `AGENTS.md` and the
docs must be updated.** Embeddings never leave the Worker: responses carry
face ids, bboxes, person ids and scores only.

- `GET /people`: persons with confirmed counts and a cover face.
- `GET /people/groups`: unnamed groups. Takes a page of up to 1,000 `unassigned`
  faces, clusters them greedily (link when similarity to an existing member is
  at least the suggestion threshold), returns groups with face ids. Paged by
  cursor so the cap is respected.
- `POST /people` (create with name) and `PATCH /people/:id` (rename).
- `POST /faces/:id/assign {person_id}`: sets `confirmed`, removes any rejection
  for that pair.
- `POST /faces/:id/reject {person_id}`: records the rejection, returns the face
  to `unassigned`, so it is never auto-matched to that person again.
- `POST /faces/:id/unassign`: back to `unassigned`.
- `GET /people/:id/matches`: on demand. Scores a page of up to 1,000
  `unassigned` and `auto` faces against the person's confirmed faces (best
  similarity over the references) and returns candidates at or above the
  suggestion floor, excluding rejected pairs. Pass `apply=true` and faces at or
  above the auto threshold are saved as `auto`; faces between the floor and the
  auto threshold are returned as suggestions only, not saved.
- `GET /people/:id/photos` and a `people=a,b` filter on `/search` and album
  photos for "together" (a join on `faces`, all listed persons present in the
  photo; `auto` and `confirmed` both count, confirmed ranked first).
- A shared module holds the thresholds: auto attach **0.5**, suggestion floor
  **0.4**, tuned from the spike. The age test shows children land between 0.43
  and 0.56, so the amber band is expected to be busy for them. Constants, not
  database config.

**Correction behaviour:** a wrong `auto` match shows in the photo's face list
with its person name and a "Not X" action. "Not X" writes the rejection and
unassigns. "This is Y" assigns and confirms. A `confirmed` face is never
changed by matching, only by the owner. If the owner deletes a person, its
faces return to `unassigned` and its rejections are dropped.

### Frontend

- **Photo page:** a "Find similar" button opens a panel with filter chips
  (text, tags, subjects, album, date, min rating) and the results grid. It shows
  the "searched N of M" note when capped. Face boxes drawn over the photo; click
  a face to name it, pick an existing person, or reject a wrong match.
- **People page:** groups of unnamed faces (face tiles), name a whole group
  at once, plus named persons with counts. Per person: their photos, a "Find
  more photos of {name}" action (runs `matches`), and a review queue for
  suggestions with Yes / Not them.
- **Search and album pages:** a people filter (multi-select) for "together".
- Mobile-friendly: tiles and panels reflow, no hover-only actions.

### Free-tier cost sketch (to be measured, not promised)

- Similar: at most 1,000 rows read and 1,000 x 768 multiply-adds per click
  (about 0.77 M). At 30,000 photos the library total (90 MB of image vectors)
  fits free D1 storage, and the cap keeps per-click cost flat as the library
  grows.
- Faces: similar per-request bound of 1,000 faces x 512-d (about 0.5 M).
- Verify the actual CPU time with a Worker test or a local `wrangler dev`
  benchmark at 1,000 candidates before shipping. If a request is too slow,
  lower the cap or move scoring to the agent behind the tunnel.

## Phasing

1. **Image vectors and find-similar** (migration 0009): sidecar, embedding in
   the indexing pass, `backfill-vectors`, `/photos/:id/similar`, the button and
   filters. Ships on its own.
2. **Faces and people** (migration 0010): face detection in the sidecar,
   `/ingest/faces`, naming, People page, matching, corrections, "together".

Each is its own PR with docs updated in the same commit (README, `AGENTS.md`,
`docs/architecture.md`).

## Testing

- Worker: the scoring module (known vectors, ties, ordering), the 1,000 cap and
  `capped` flag, filter combinations, rejection persistence, "confirmed is never
  overwritten" for both ingest and matching, together-queries, schema tests for
  both migrations.
- Agent: a fake sidecar, backfill resume, and that the agent never writes
  `person_id` or `assign_status`.
- Frontend: Find similar panel (filters, capped note), face naming and rejection
  flows, People page.
- Matching quality is judged on the owner's real photos (reference faces across
  ages), not unit tests. Keep a small fixture of vectors for thresholds.

## Left to the builder

- Sidecar transport (HTTP vs stdio), process lifecycle and how `launchd` starts
  it. The working image size for face detection.
- Vector encoding in the BLOB (float32 is the default; float16 or int8 is
  allowed if it measurably helps and the dot product stays exact enough).
- Clustering details for the People groups page.
- UI layout details, within the flows above.

## Calls the designer made (owner to check)

- Cap rule without text: same album first, then closest capture time, up to
  1,000.
- Auto-attach threshold 0.5 and suggestion floor 0.4 (from the spike, a
  starting point).
- Only `confirmed` faces are references.
- Suggestions between the floor and the auto threshold are computed on demand
  and not stored. Only `auto` and `confirmed` rows persist.
- The matching and People groups routes are paged at 1,000 faces per request,
  mirroring the similar-photos cap.
- Two migrations and two PRs, image vectors first.
- Sidecar is Python (open_clip and insightface), because Ollama does not appear
  to serve SigLIP or ArcFace.

## Risks

- Children's faces change fast; expect many suggestions rather than
  auto-matches until several ages are confirmed.
- The Worker CPU budget is unmeasured. The cap is the safety valve.
- A Python dependency joins the Node agent on the owner's Mac.
- Face embeddings are biometric data. They stay in D1 behind the read token and
  are never returned to the browser.
