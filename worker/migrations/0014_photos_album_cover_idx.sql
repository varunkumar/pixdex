-- 0013 meant to widen idx_photos_album, but 0001 already created an index with that name, so it was a
-- no-op. This is a separate covering index for the albums page: the per-album aggregate and the cover
-- ranking read only its entries (album, dates, rating inputs, id, content_hash), never the wide photo
-- rows. The older plain album index stays (additive only) and is simply not chosen for those queries.
CREATE INDEX IF NOT EXISTS idx_photos_album_cover ON photos (album, date_time, last_indexed, user_rating, aesthetic_score, id, content_hash);
