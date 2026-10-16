-- Owner-chosen cover face for a person. Nullable and not a foreign key: when the face is no
-- longer assigned to the person, readers fall back to the best confirmed face.
-- Additive only.
ALTER TABLE persons ADD COLUMN cover_face_id TEXT;
