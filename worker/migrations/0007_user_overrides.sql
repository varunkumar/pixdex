-- Human-in-the-loop edits to the AI output. NULL means "no override"; the agent's
-- re-index upsert never touches these columns, so a re-run cannot erase an edit.
-- user_rating: 1-5 stars. user_caption: replaces short_caption.
-- user_subjects / user_tags: JSON arrays that replace subjects / tags.
ALTER TABLE photos ADD COLUMN user_rating INTEGER;
ALTER TABLE photos ADD COLUMN user_caption TEXT;
ALTER TABLE photos ADD COLUMN user_subjects TEXT;
ALTER TABLE photos ADD COLUMN user_tags TEXT;
