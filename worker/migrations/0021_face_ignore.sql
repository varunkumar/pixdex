-- Ignored faces. One nullable column on faces (NULL = not ignored). An ignored face is always unassigned.
-- No data is removed: two indexes are replaced by partial ones that leave ignored faces out, so a face insert
-- writes the same number of index rows as before.
ALTER TABLE faces ADD COLUMN ignored_at TEXT;
-- The ignored list, newest first (rowid breaks ties).
CREATE INDEX IF NOT EXISTS idx_faces_ignored ON faces (ignored_at) WHERE ignored_at IS NOT NULL;
-- Unnamed groups never read an ignored face.
CREATE INDEX IF NOT EXISTS idx_faces_open_status ON faces (assign_status) WHERE ignored_at IS NULL;
DROP INDEX IF EXISTS idx_faces_assign_status;
-- Known-person list and filter never read an ignored face. The trailing ignored_at keeps the list covering.
CREATE INDEX IF NOT EXISTS idx_faces_known_shown ON faces (known_id, photo_id, ignored_at)
  WHERE known_id IS NOT NULL AND ignored_at IS NULL;
DROP INDEX IF EXISTS idx_faces_known_photo;
