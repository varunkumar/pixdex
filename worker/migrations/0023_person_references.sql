-- The confirmed faces each person is matched with, chosen to cover the years they were photographed in (see
-- worker/src/people/referenceSelection.ts; the Worker keeps it current). Additive only: faces and its indexes are
-- unchanged.
CREATE TABLE IF NOT EXISTS person_references (
  person_id TEXT NOT NULL,
  face_id TEXT NOT NULL,
  PRIMARY KEY (person_id, face_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_person_references_face ON person_references (face_id);

-- Fill it for existing people: one face per year in turns (undated is its own year), the largest first, 30 at most.
INSERT OR IGNORE INTO person_references (person_id, face_id)
SELECT person_id, face_id FROM (
  SELECT person_id, face_id, ROW_NUMBER() OVER (PARTITION BY person_id ORDER BY turn, year, rid) AS pick FROM (
    SELECT f.person_id, f.id AS face_id, f.rowid AS rid, COALESCE(substr(ph.date_time, 1, 4), '') AS year,
      ROW_NUMBER() OVER (
        PARTITION BY f.person_id, COALESCE(substr(ph.date_time, 1, 4), '')
        ORDER BY f.bbox_w * f.bbox_h DESC, f.det_score DESC, f.rowid
      ) AS turn
    FROM persons p
    CROSS JOIN faces f ON f.person_id = p.id AND f.assign_status = 'confirmed'
    LEFT JOIN photos ph ON ph.id = f.photo_id
  )
) WHERE pick <= 30;
