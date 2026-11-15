-- Species identification (agent-side BioCLIP 2). Additive only: two columns on photos, no index, no trigger.
-- species is a JSON array of {common, scientific, score, box?}; species_model names the model that wrote it.
-- The agent writes both (POST /ingest/species, or optionally POST /ingest/photo); the owner's edits live in user_* columns.
ALTER TABLE photos ADD COLUMN species TEXT NOT NULL DEFAULT '[]';
ALTER TABLE photos ADD COLUMN species_model TEXT;
