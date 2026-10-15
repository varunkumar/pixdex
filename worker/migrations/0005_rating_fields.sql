-- aesthetic_score: 1-10 vision-model rating of how good the photo looks.
-- short_caption: a 3-4 word title for the photo.
-- NULL means not generated yet.
ALTER TABLE photos ADD COLUMN aesthetic_score REAL;
ALTER TABLE photos ADD COLUMN short_caption TEXT;
