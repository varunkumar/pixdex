import { env } from 'cloudflare:test';
import { beforeAll } from 'vitest';

beforeAll(async () => {
  // Apply migrations manually
  const statements = [
    `CREATE TABLE photos (
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
)`,
    `CREATE INDEX idx_photos_album ON photos(album)`,
    `CREATE INDEX idx_photos_date_time ON photos(date_time)`,
    `CREATE VIRTUAL TABLE photos_fts USING fts5(
  search_text,
  content = 'photos',
  content_rowid = 'rowid',
  tokenize = 'porter unicode61'
)`,
    `CREATE TRIGGER photos_ai AFTER INSERT ON photos BEGIN
  INSERT INTO photos_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END`,
    `CREATE TRIGGER photos_ad AFTER DELETE ON photos BEGIN
  INSERT INTO photos_fts(photos_fts, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
END`,
    `CREATE TRIGGER photos_au AFTER UPDATE ON photos BEGIN
  INSERT INTO photos_fts(photos_fts, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
  INSERT INTO photos_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END`,
  ];

  for (const sql of statements) {
    await env.DB.prepare(sql).run();
  }
});
