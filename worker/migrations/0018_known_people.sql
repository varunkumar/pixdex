-- Known personalities (phase 1). Additive only: one new table, two nullable columns on faces, one partial index.
-- known_people.id is a Wikidata id such as Q1234; aliases is a JSON array of strings.
CREATE TABLE IF NOT EXISTS known_people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
ALTER TABLE faces ADD COLUMN known_id TEXT;
ALTER TABLE faces ADD COLUMN known_score REAL;
-- Serves the filter by known person (photos that contain every selected known person).
CREATE INDEX IF NOT EXISTS idx_faces_known_photo ON faces (known_id, photo_id) WHERE known_id IS NOT NULL;
