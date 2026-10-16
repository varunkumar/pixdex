-- People and faces. Additive only. bbox values are normalised 0..1 of the image
-- width and height. The agent never writes person_id or assign_status; the Worker
-- sets 'auto' when matching clears a threshold and the owner sets 'confirmed'.
CREATE TABLE IF NOT EXISTS persons (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_persons_name_lower ON persons (lower(name));

CREATE TABLE IF NOT EXISTS faces (
  id TEXT PRIMARY KEY,
  photo_id TEXT NOT NULL,
  bbox_x REAL NOT NULL,
  bbox_y REAL NOT NULL,
  bbox_w REAL NOT NULL,
  bbox_h REAL NOT NULL,
  det_score REAL NOT NULL,
  embedding BLOB NOT NULL,
  embedding_model TEXT NOT NULL,
  person_id TEXT,
  assign_status TEXT NOT NULL DEFAULT 'unassigned'
    CHECK (assign_status IN ('unassigned', 'auto', 'confirmed')),
  match_score REAL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_faces_photo_id ON faces (photo_id);
CREATE INDEX IF NOT EXISTS idx_faces_person_id ON faces (person_id);
CREATE INDEX IF NOT EXISTS idx_faces_assign_status ON faces (assign_status);

CREATE TABLE IF NOT EXISTS face_rejections (
  face_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  PRIMARY KEY (face_id, person_id)
);

ALTER TABLE photos ADD COLUMN faces_scanned_model TEXT;
