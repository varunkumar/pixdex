-- Colors, patterns, season and camera make were not part of search_text.
-- Runs once; the photos_au trigger keeps the FTS index in step.
UPDATE photos SET search_text = trim(
  search_text
  || ' ' || COALESCE((SELECT group_concat(value, ' ') FROM json_each(photos.colors)), '')
  || ' ' || COALESCE((SELECT group_concat(value, ' ') FROM json_each(photos.patterns)), '')
  || ' ' || COALESCE(season, '')
  || ' ' || COALESCE(camera_make, '')
);
