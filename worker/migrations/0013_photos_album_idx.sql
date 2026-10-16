-- Covering index for the albums page: the per-album aggregate and the cover ranking read only
-- this index (album, dates, rating inputs, id, content_hash), never the wide photos rows, and the
-- cover ranking touches just the requested albums' entries. Additive only.
CREATE INDEX IF NOT EXISTS idx_photos_album ON photos (album, date_time, last_indexed, user_rating, aesthetic_score, id, content_hash);
