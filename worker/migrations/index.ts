// Migration SQL statements exported for both CLI and test usage
// Single source of truth to avoid duplication

export const PHOTOS_MIGRATION_SQL = `CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  path TEXT,
  drive_file_id TEXT,
  filename TEXT NOT NULL,
  date_time TEXT,
  width INTEGER,
  height INTEGER,
  format TEXT,
  file_size INTEGER,
  subjects TEXT NOT NULL DEFAULT '[]',
  colors TEXT NOT NULL DEFAULT '[]',
  patterns TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  season TEXT,
  environment TEXT,
  album TEXT,
  description TEXT NOT NULL DEFAULT '',
  suggested_caption TEXT NOT NULL DEFAULT '',
  suggested_hashtags TEXT NOT NULL DEFAULT '[]',
  model_provider TEXT NOT NULL,
  model_name TEXT NOT NULL,
  search_text TEXT NOT NULL DEFAULT '',
  last_indexed TEXT NOT NULL,
  instagram_suggested TEXT
);

CREATE INDEX IF NOT EXISTS idx_photos_album ON photos(album);
CREATE INDEX IF NOT EXISTS idx_photos_date_time ON photos(date_time);

CREATE VIRTUAL TABLE IF NOT EXISTS photos_fts USING fts5(
  search_text,
  content = 'photos',
  content_rowid = 'rowid',
  tokenize = 'porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS photos_ai AFTER INSERT ON photos BEGIN
  INSERT INTO photos_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;

CREATE TRIGGER IF NOT EXISTS photos_ad AFTER DELETE ON photos BEGIN
  INSERT INTO photos_fts(photos_fts, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
END;

CREATE TRIGGER IF NOT EXISTS photos_au AFTER UPDATE ON photos BEGIN
  INSERT INTO photos_fts(photos_fts, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
  INSERT INTO photos_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;`;

// Split statements for test execution - each statement terminated with ;
// Handle CREATE TRIGGER statements which span multiple lines with internal semicolons
const BASE_MIGRATION_STATEMENTS = (() => {
  const statements: string[] = [];
  let current = '';
  let inTrigger = false;

  const lines = PHOTOS_MIGRATION_SQL.split('\n');
  for (const line of lines) {
    if (line.trim().startsWith('CREATE TRIGGER')) {
      inTrigger = true;
    }

    current += line + '\n';

    if (inTrigger && line.trim() === 'END;') {
      statements.push(current.trim());
      current = '';
      inTrigger = false;
    } else if (!inTrigger && line.trim().endsWith(';') && line.trim() !== '') {
      statements.push(current.trim());
      current = '';
    }
  }

  return statements.filter((stmt) => stmt.length > 0);
})();

// Mirrors 0002_exif_fields.sql (same single-source-for-tests rationale as above).
export const EXIF_MIGRATION_STATEMENTS = [
  'ALTER TABLE photos ADD COLUMN camera_make TEXT;',
  'ALTER TABLE photos ADD COLUMN camera_model TEXT;',
  'ALTER TABLE photos ADD COLUMN lens_model TEXT;',
  'ALTER TABLE photos ADD COLUMN focal_length REAL;',
  'ALTER TABLE photos ADD COLUMN f_number REAL;',
  'ALTER TABLE photos ADD COLUMN exposure_time REAL;',
  'ALTER TABLE photos ADD COLUMN iso INTEGER;',
  'ALTER TABLE photos ADD COLUMN latitude REAL;',
  'ALTER TABLE photos ADD COLUMN longitude REAL;',
  // Mirrors 0004_has_watermark.sql.
  'ALTER TABLE photos ADD COLUMN has_watermark INTEGER;',
  // Mirrors 0005_rating_fields.sql.
  'ALTER TABLE photos ADD COLUMN aesthetic_score REAL;',
  'ALTER TABLE photos ADD COLUMN short_caption TEXT;',
  // Mirrors 0006_album_covers.sql.
  'CREATE TABLE IF NOT EXISTS album_covers (album TEXT PRIMARY KEY, photo_id TEXT NOT NULL);',
  // Mirrors 0007_user_overrides.sql.
  'ALTER TABLE photos ADD COLUMN user_rating INTEGER;',
  'ALTER TABLE photos ADD COLUMN user_caption TEXT;',
  'ALTER TABLE photos ADD COLUMN user_subjects TEXT;',
  'ALTER TABLE photos ADD COLUMN user_tags TEXT;',
  // Mirrors 0008_search_weighting.sql (schema part; the test DB starts empty so no backfill).
  'DROP TRIGGER IF EXISTS photos_ai;',
  'DROP TRIGGER IF EXISTS photos_ad;',
  'DROP TRIGGER IF EXISTS photos_au;',
  'DROP TABLE IF EXISTS photos_fts;',
  "ALTER TABLE photos ADD COLUMN search_primary TEXT NOT NULL DEFAULT '';",
  `CREATE VIRTUAL TABLE photos_fts USING fts5(
  search_text,
  search_primary,
  content = 'photos',
  content_rowid = 'rowid',
  tokenize = 'porter unicode61'
);`,
  `CREATE TRIGGER photos_ai AFTER INSERT ON photos BEGIN
  INSERT INTO photos_fts(rowid, search_text, search_primary) VALUES (new.rowid, new.search_text, new.search_primary);
END;`,
  `CREATE TRIGGER photos_ad AFTER DELETE ON photos BEGIN
  INSERT INTO photos_fts(photos_fts, rowid, search_text, search_primary) VALUES ('delete', old.rowid, old.search_text, old.search_primary);
END;`,
  `CREATE TRIGGER photos_au AFTER UPDATE ON photos BEGIN
  INSERT INTO photos_fts(photos_fts, rowid, search_text, search_primary) VALUES ('delete', old.rowid, old.search_text, old.search_primary);
  INSERT INTO photos_fts(rowid, search_text, search_primary) VALUES (new.rowid, new.search_text, new.search_primary);
END;`,
  // Mirrors 0009_people.sql.
  `CREATE TABLE IF NOT EXISTS persons (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);`,
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_persons_name_lower ON persons (lower(name));',
  `CREATE TABLE IF NOT EXISTS faces (
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
);`,
  'CREATE INDEX IF NOT EXISTS idx_faces_photo_id ON faces (photo_id);',
  'CREATE INDEX IF NOT EXISTS idx_faces_person_id ON faces (person_id);',
  'CREATE INDEX IF NOT EXISTS idx_faces_assign_status ON faces (assign_status);',
  `CREATE TABLE IF NOT EXISTS face_rejections (
  face_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  PRIMARY KEY (face_id, person_id)
);`,
  'ALTER TABLE photos ADD COLUMN faces_scanned_model TEXT;',
  // Mirrors 0010_faces_person_status_created_idx.sql.
  'CREATE INDEX IF NOT EXISTS idx_faces_person_status_created ON faces (person_id, assign_status, created_at);',
  // Mirrors 0011_person_cover.sql.
  'ALTER TABLE persons ADD COLUMN cover_face_id TEXT;',
  // Mirrors 0012_face_crop.sql.
  'ALTER TABLE faces ADD COLUMN crop_key TEXT;',
];

export const PHOTOS_MIGRATION_STATEMENTS = [...BASE_MIGRATION_STATEMENTS, ...EXIF_MIGRATION_STATEMENTS];

// Mirrors 0003_search_text_fields.sql. Exported so a test can run it against seeded rows;
// it is deliberately not part of PHOTOS_MIGRATION_STATEMENTS (the test DB starts empty).
export const SEARCH_TEXT_BACKFILL_SQL = `UPDATE photos SET search_text = trim(
  search_text
  || ' ' || COALESCE((SELECT group_concat(value, ' ') FROM json_each(photos.colors)), '')
  || ' ' || COALESCE((SELECT group_concat(value, ' ') FROM json_each(photos.patterns)), '')
  || ' ' || COALESCE(season, '')
  || ' ' || COALESCE(camera_make, '')
)`;

// Mirrors the UPDATE in 0008_search_weighting.sql, exported so a test can run it on seeded rows.
export const SEARCH_PRIMARY_BACKFILL_SQL = `UPDATE photos SET search_primary = trim(
  COALESCE((SELECT group_concat(value, ' ') FROM json_each(COALESCE(user_subjects, subjects))), '')
  || ' ' || COALESCE((SELECT group_concat(value, ' ') FROM json_each(COALESCE(user_tags, tags))), '')
  || ' ' || COALESCE((SELECT group_concat(value, ' ') FROM json_each(colors)), '')
  || ' ' || COALESCE(user_caption, short_caption, '')
)`;
