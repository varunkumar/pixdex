-- album_covers: the photo chosen as an album's cover. Albums without a row keep
-- the automatic cover (newest dated photo).
CREATE TABLE IF NOT EXISTS album_covers (
  album TEXT PRIMARY KEY,
  photo_id TEXT NOT NULL
);
