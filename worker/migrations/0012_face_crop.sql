-- R2 key of a sharp, padded crop of the face cut from the original by the agent.
-- Nullable: faces scanned before this have none and readers fall back to the thumbnail.
-- Additive only.
ALTER TABLE faces ADD COLUMN crop_key TEXT;
