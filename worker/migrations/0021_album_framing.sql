-- Album cover framing (owner-edited): JSON {hash, x, y, zoom}, or NULL for the centre at 1x. It applies only while
-- hash equals the album's current cover. Additive only: no index, and the albums triggers (0015) never name it.
ALTER TABLE albums ADD COLUMN cover_framing TEXT;
