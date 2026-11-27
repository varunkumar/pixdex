-- Ignored faces. One nullable column on faces (NULL = not ignored). An ignored face is always unassigned.
-- Purely additive: no existing index changes. Each new index is partial on ignored_at, so SQLite can only use it
-- for a query that names ignored_at; every earlier query keeps exactly the plan it had.
-- Cost: a new face writes one more index row (two with a known match).
ALTER TABLE faces ADD COLUMN ignored_at TEXT;
-- The ignored list, newest first (rowid breaks ties). Holds ignored faces only.
CREATE INDEX IF NOT EXISTS idx_faces_ignored ON faces (ignored_at) WHERE ignored_at IS NOT NULL;
-- Unnamed groups never read an ignored face.
CREATE INDEX IF NOT EXISTS idx_faces_open_status ON faces (assign_status) WHERE ignored_at IS NULL;
-- Known-person list and filter never read an ignored face; the trailing ignored_at keeps them covering.
CREATE INDEX IF NOT EXISTS idx_faces_known_shown ON faces (known_id, photo_id, ignored_at)
  WHERE known_id IS NOT NULL AND ignored_at IS NULL;
