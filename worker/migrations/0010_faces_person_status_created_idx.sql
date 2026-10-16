-- Bounds loadReferences: newest confirmed faces per person via an index range scan.
-- Additive only.
CREATE INDEX IF NOT EXISTS idx_faces_person_status_created ON faces (person_id, assign_status, created_at);
