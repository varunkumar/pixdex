# Image vectors, similar photos and people: design

Status: draft for owner approval. Nothing here is built yet.

## Intent

PixdeX search is text only (D1 FTS5 over what the vision model wrote). Two
things text cannot do well:

1. "Show me photos that look like this one."
2. "Show me every photo of this person", and "Person 1 and Person 2 together".

Both need vectors computed from pixels. This design adds them with no vector
store, no Workers AI and no paid Cloudflare feature: the local agent computes
vectors and pushes them to D1, and the Worker scores them. Face matching is
automatic (when photos are ingested and when a person is named); find-similar is
on demand, on a bounded candidate set.

## Goals

- **People** (built first): the owner names a face once and the matching attaches
  that name to the same person in other photos. Naming works both by clicking a
  face inside a photo and from a People page of unnamed groups.
- **Find similar** photos (built second), behind a button on the photo page,
  computed on demand, never against more than a fixed cap of candidates
  (1,000, tunable down to 200). The candidates are chosen from the photo
  itself: its own subjects, tags, colours and season. No user-entered filters,
  and nothing from date, location or album.
- **Correcting wrong matches** is a first-class action, and a correction is
  never overwritten by later matching.
- "Person A and Person B together" is a filter on the search and album pages.
- Works from desktop and mobile (the browser only talks to the Worker).

## Deliberate cuts (phase A)

- "Together" search does not rank photos with the confirmed face first.
- There is no people filter on the album page.

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
- InsightFace is the toolkit, ArcFace is the method. `buffalo_l` bundles an
  SCRFD face detector with a recognition network trained with the ArcFace loss
  (ResNet-50, 512-d). "ArcFace embeddings via InsightFace" means that one
  recognition model.
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
- Similar photos are on demand behind a button. Each request scores at most a
  fixed cap of candidate photos (**1,000**, and it may be lowered to **200** if
  the CPU measurement requires it). The candidates are derived from the photo
  itself (its subjects, tags, colours and season), so a tiger photo is compared
  with tiger-like photos. There are no user-entered filters, and nothing comes
  from date, location or album. This is a design rule from day one.
- Build order: **faces and people first (phase A), find-similar second
  (phase B).**
- Face matching is **automatic**: new photos are matched against the people you
  have named as they are ingested, and naming a face matches the existing
  unnamed faces. Only find-similar is on demand. There is a way to correct
  wrong matches. (Updated 2026-10-16: an earlier draft had matching behind a
  button.)
- Naming works both ways: click a face in a photo, and a People page of groups.
- Face recognition is a primary feature alongside find-similar.

## Design

### Data model (two migrations, both additive)

`0009_people.sql` (phase A)

- `persons(id, name, created_at)`. Names are the owner's text.
- `faces(id, photo_id, bbox_x, bbox_y, bbox_w, bbox_h, det_score, embedding BLOB,
  embedding_model, person_id NULL, assign_status, match_score, created_at)`.
  `assign_status` is one of `unassigned`, `auto`, `confirmed`. Only the owner
  (browser writes) sets `confirmed`. The agent only sends boxes and vectors and
  never sends `person_id` or `assign_status`; the Worker itself sets `auto` when
  its own matching clears the threshold, and never touches `confirmed`.
- `face_rejections(face_id, person_id)` primary key on the pair: "this face is
  not that person". Persisted so a correction survives re-matching.
- Indexes on `faces(photo_id)`, `faces(person_id)`, `faces(assign_status)`.

`0012_image_embeddings.sql` (phase B; `0010` is the faces reference index and `0011` the person cover column, both phase A)

- `photos.image_embedding BLOB` (768 float32, 3 KB) and
  `photos.image_embedding_model TEXT` (e.g. `siglip2-b16-256`). Scoring only
  compares vectors with the same model value, so a model swap means re-embedding
  and nothing silently mixes.

`confirmed` faces are the only reference vectors for a person. `auto` matches
never become references (no drift). Confirming an `auto` match upgrades it to a
reference. Face bounding boxes are stored so the UI can draw them over the
thumbnail and crop face tiles without sending embeddings.

### Agent

- `agent/sidecar/` (Python), a small local HTTP or stdio service. Phase A uses
  `insightface`; phase B adds `open_clip` for SigLIP 2. The Node agent sends it
  an image and receives the detected faces (bbox, score, vector), and in phase B
  the image vector too. Qwen captioning stays in Ollama, unchanged.
- Embedding runs in the same pass as captioning, from the same resized image,
  so each photo is read and decoded once. Face detection needs more pixels than
  a small thumbnail (the spike used 1280 px); builder to confirm the working
  size.
- New CLI commands (resumable, like `backfill-exif`) for the existing library:
  `backfill-faces <folder>` in phase A and `backfill-vectors <folder>` in phase
  B. `index-batch` and `index-local` call the same code for new photos.
- New ingest routes: `POST /ingest/faces` (phase A) and
  `POST /ingest/embedding` (phase B), behind `INGEST_TOKEN`, not in the Pages
  allowlist. Re-ingest of a photo replaces its
  `unassigned` and `auto` faces but never deletes or edits `confirmed` ones.

### Worker: similar photos (phase B)

`GET /photos/:id/similar` takes no parameters and returns only the **3 to 4 closest photos** (a constant, 4 by default). The filters are not
supplied by the user. The Worker reads the query photo's own fields and builds
the candidate set from them.

- **Candidate query:** an FTS5 OR query built from the photo's own text fields.
  Subjects are the strongest terms (weighted like the existing `search_primary`
  column, so a tiger photo is matched to photos whose subjects include tiger),
  with tags, colours and season as additional terms. The owner's corrected
  values (`user_*`) are used when set, the same as search. The existing synonym
  and word-family expansion (leopard and panthera pardus, etc.) applies, so
  related labels count. Ranking is bm25.
- If the photo has no usable text fields, the candidates fall back to the most
  recently indexed photos that have an embedding.
- The Worker keeps at most **`SIMILAR_CANDIDATE_CAP`** candidates (default 1,000,
  one constant, tunable down to 200), loads their vectors, and scores them
  against the query photo by cosine similarity (vectors are L2-normalised, so it
  is a dot product). Final order is by vector similarity, and only the top 4 are returned.
- The response includes `candidate_count`, `scored_count` and `capped: true`
  when the cap applied, so the UI can say "compared with the 1,000 closest
  matches by subject and tags". The query photo itself is excluded.
- The scorer lives in one shared module so the cap is in one place
  (`worker/src/search/similarity.ts`).

### Worker: people

All read routes need `READ_TOKEN` and go in the Pages allowlist. The browser
writes (name, assign, reject) are added to the proxy's forwarded writes next to
`PUT albums/cover` and `PATCH photos/:id`. **That list in `AGENTS.md` and the
docs must be updated.** Embeddings never leave the Worker: responses carry
face ids, bboxes, person ids and scores only.

- `GET /people`: persons with confirmed counts and a cover face.
- `GET /people/groups`: unnamed groups. Takes a page of up to 100 `unassigned`
  faces, clusters them greedily (link when similarity to an existing member is
  at least the suggestion threshold), returns groups with face ids. Paged by
  cursor so the cap is respected.
- `POST /people` (create with name) and `PATCH /people/:id` (rename).
- `POST /faces/:id/assign {person_id}`: sets `confirmed`, removes any rejection
  for that pair.
- `POST /faces/:id/reject {person_id}`: records the rejection, returns the face
  to `unassigned`, so it is never auto-matched to that person again.
- `POST /faces/:id/unassign`: back to `unassigned`.
- `POST /people/:id/match` body `{ apply?, cursor? }`: scores one page of up to
  200 `unassigned` faces (and `auto` faces of other people, taken only on a
  higher score) against the person's reference faces and returns those at or
  above the suggestion floor, excluding rejected pairs. With `apply: true`
  faces at or above the auto threshold are saved as `auto`; faces between the
  floor and the auto threshold are returned as suggestions only, never saved.
  The frontend calls it with `apply: true` page by page after you name a face,
  until `nextCursor` is null. Without `apply` it powers the suggestion review
  queue.

**Automatic matching.** Two triggers, both applying only the auto band:
1. **At ingest.** When `/ingest/faces` stores a photo's new faces, the Worker
   matches them against every person's reference faces and saves matches as
   `auto`. Photos with no faces load nothing. Rejected pairs are respected.
2. **When a face is named.** After create, assign or bulk assign, the frontend
   runs the apply-matching loop for that person over the unnamed faces already
   in the library.
**Candidates are only photos with usable faces.** Matching never looks at the
photo table at large. It reads the `faces` table, which only has rows for photos
where the agent detected a face (wildlife photos have none and are never
touched). Within that, only faces good enough to match are considered:
`det_score >= MIN_DET_SCORE` (0.6) and both box sides `>= MIN_FACE_SIDE` (0.03 of
the image, about 38 px at the 1280 px scan size). Smaller or weaker faces are
stored (so the photo page can show them and you can name them by hand) but are
left out of automatic matching, groups and suggestions. Both numbers are
starting points to tune on real photos.
References per person are capped at the **30 newest confirmed faces**
(`REFERENCES_PER_PERSON`) so an ingest reads a bounded number of rows (people
x 30), which keeps the free D1 read quota safe during a backfill.
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

- **Photo page:** face boxes drawn over the photo; click a face to name it, pick
  an existing person, or reject a wrong match (phase A). A "Find similar" button
  opens the results grid, with a note on how many photos were compared when
  capped (phase B). It has no filter controls.
- **People page:** groups of unnamed faces (face tiles), name a whole group
  at once, plus named persons with counts. Per person: their photos, a "Review
  suggestions" action (runs `match` without `apply`) that shows the "Is this
  {name}?" band with Yes / Not them. Matching itself is automatic.
- **Search and album pages:** a people filter (multi-select) for "together".
- Mobile-friendly: tiles and panels reflow, no hover-only actions.

### Free-tier cost sketch (to be measured, not promised)

- Similar: at most the cap in rows read and cap x 768 multiply-adds per click
  (about 0.77 M at 1,000, about 0.15 M at 200). At 30,000 photos the library
  total (90 MB of image vectors) fits free D1 storage, and the cap keeps
  per-click cost flat as the library grows.
- Faces: matching is bounded to 200 faces per request (x 512-d, about 0.1 M per reference, up to 30 references) and groups to 100 faces per page, ingest-time matching to 1.5 M multiply-adds per request and ingest to 10 faces per request. The Workers Free CPU limit (~10 ms) and D1's per-invocation query limit drove these sizes; real CPU is still to be measured on a deployed preview.
- Verify the actual CPU time with a Worker test or a local `wrangler dev`
  benchmark at 1,000 candidates before shipping. If a request is too slow,
  lower the cap (down to 200 is acceptable to the owner) or move scoring to the
  agent behind the tunnel.

## Phasing

A. **Faces and people** (migration 0009): face detection in the sidecar,
   `/ingest/faces`, `backfill-faces`, naming from a photo and from the People
   page, matching, corrections, "together".
B. **Image vectors and find-similar** (migration 0012): `open_clip` added to the
   sidecar, embedding in the indexing pass, `backfill-vectors`,
   `/photos/:id/similar`, and the button.

Each is its own PR with docs updated in the same commit (README, `AGENTS.md`,
`docs/architecture.md`).

## Testing

- Worker: the scoring module (known vectors, ties, ordering), the candidate cap
  and `capped` flag, candidate derivation from subjects, tags, colours and season, rejection persistence, "confirmed is never
  overwritten" for both ingest and matching, together-queries, schema tests for
  both migrations.
- Agent: a fake sidecar, backfill resume, and that the agent never writes
  `person_id` or `assign_status`, and that the Worker's ingest-time match saves
  only `auto` matches and never changes a `confirmed` face.
- Frontend: Find similar results (capped note), face naming and rejection
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

- Find-similar derives its candidates from the query photo's own subjects, tags,
  colours and season (OR query, bm25 ranked), up to the cap. Subjects weigh
  most.
- Cap defaults to 1,000 and is one constant that can drop to 200.
- Auto-attach threshold 0.5 and suggestion floor 0.4 (from the spike, a
  starting point).
- Only `confirmed` faces are references.
- Suggestions between the floor and the auto threshold are computed when you
  open the review queue and not stored. Only `auto` and `confirmed` rows
  persist.
- Automatic matching uses at most the 30 newest confirmed faces per person as
  references (revisit if children's older ages stop matching).
- The matching route is paged at 200 faces per request and People groups at 100 (the Workers Free CPU limit, ~10 ms,
  drove this; groups clusters against one running centroid per cluster).
- Two migrations and two PRs, faces and people first (the owner's order).
- Sidecar is Python (open_clip and insightface), because Ollama does not appear
  to serve SigLIP or ArcFace.

## Risks

- Children's faces change fast; expect many suggestions rather than
  auto-matches until several ages are confirmed.
- The Worker CPU budget is unmeasured. The cap is the safety valve.
- A Python dependency joins the Node agent on the owner's Mac.
- Face embeddings are biometric data. They stay in D1 behind the read token and
  are never returned to the browser.
