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
