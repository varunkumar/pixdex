-- Viewer-private person names. A person's persons.name is its owner's private label; any other viewer who can see
-- the person gets a NULL name unless they set their own label here. Additive: one new empty table.
CREATE TABLE IF NOT EXISTS person_labels (
  viewer_email TEXT NOT NULL,
  person_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (viewer_email, person_id)
);
-- A viewer's labels are unique case-insensitively (only among labels, not against persons they own).
CREATE UNIQUE INDEX IF NOT EXISTS idx_person_labels_viewer_name_lower ON person_labels (viewer_email, lower(name));
-- Makes the delete-by-person trigger and DELETE ... WHERE person_id = ? an index search.
CREATE INDEX IF NOT EXISTS idx_person_labels_person ON person_labels(person_id);
CREATE TRIGGER IF NOT EXISTS person_labels_email_lower_bi BEFORE INSERT ON person_labels
WHEN new.viewer_email <> lower(new.viewer_email)
BEGIN SELECT RAISE(ABORT, 'emails on person_labels must be lowercase'); END;
CREATE TRIGGER IF NOT EXISTS person_labels_email_lower_bu BEFORE UPDATE OF viewer_email ON person_labels
WHEN new.viewer_email <> lower(new.viewer_email)
BEGIN SELECT RAISE(ABORT, 'emails on person_labels must be lowercase'); END;
-- No orphan labels, however the person is deleted.
CREATE TRIGGER IF NOT EXISTS persons_labels_ad AFTER DELETE ON persons
BEGIN DELETE FROM person_labels WHERE person_id = old.id; END;
