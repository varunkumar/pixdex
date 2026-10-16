-- Field weighting for search. search_primary holds the high-signal text (subjects,
-- tags, colors, caption; the owner's overrides when set) so bm25 can weigh it above
-- the long free-text description. Pure SQL: no model calls, no re-index.
-- Keep the backfill in step with primaryTextForRow() in src/db/photos.ts.
DROP TRIGGER IF EXISTS photos_ai;
DROP TRIGGER IF EXISTS photos_ad;
DROP TRIGGER IF EXISTS photos_au;
DROP TABLE IF EXISTS photos_fts;

ALTER TABLE photos ADD COLUMN search_primary TEXT NOT NULL DEFAULT '';

UPDATE photos SET search_primary = trim(
  COALESCE((SELECT group_concat(value, ' ') FROM json_each(COALESCE(user_subjects, subjects))), '')
  || ' ' || COALESCE((SELECT group_concat(value, ' ') FROM json_each(COALESCE(user_tags, tags))), '')
  || ' ' || COALESCE((SELECT group_concat(value, ' ') FROM json_each(colors)), '')
  || ' ' || COALESCE(user_caption, short_caption, '')
);

CREATE VIRTUAL TABLE photos_fts USING fts5(
  search_text,
  search_primary,
  content = 'photos',
  content_rowid = 'rowid',
  tokenize = 'porter unicode61'
);

CREATE TRIGGER photos_ai AFTER INSERT ON photos BEGIN
  INSERT INTO photos_fts(rowid, search_text, search_primary) VALUES (new.rowid, new.search_text, new.search_primary);
END;

CREATE TRIGGER photos_ad AFTER DELETE ON photos BEGIN
  INSERT INTO photos_fts(photos_fts, rowid, search_text, search_primary) VALUES ('delete', old.rowid, old.search_text, old.search_primary);
END;

CREATE TRIGGER photos_au AFTER UPDATE ON photos BEGIN
  INSERT INTO photos_fts(photos_fts, rowid, search_text, search_primary) VALUES ('delete', old.rowid, old.search_text, old.search_primary);
  INSERT INTO photos_fts(rowid, search_text, search_primary) VALUES (new.rowid, new.search_text, new.search_primary);
END;

INSERT INTO photos_fts(photos_fts) VALUES ('rebuild');
