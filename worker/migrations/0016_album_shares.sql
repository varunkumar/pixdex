ALTER TABLE albums ADD COLUMN owner_email TEXT;
ALTER TABLE albums ADD COLUMN shared_with TEXT;
-- Makes the default-owner "does any album have an owner" probe and owner_email = ? lookups index searches.
CREATE INDEX IF NOT EXISTS idx_albums_owner_email ON albums (owner_email) WHERE owner_email IS NOT NULL;
-- Emails are always stored lowercase and compared exactly: the database refuses anything else, so no query needs lower().
CREATE TRIGGER IF NOT EXISTS albums_emails_lower_bi BEFORE INSERT ON albums
WHEN (new.owner_email IS NOT NULL AND new.owner_email <> lower(new.owner_email)) OR (new.shared_with IS NOT NULL AND new.shared_with <> lower(new.shared_with))
BEGIN SELECT RAISE(ABORT, 'emails on albums must be lowercase'); END;
CREATE TRIGGER IF NOT EXISTS albums_emails_lower_bu BEFORE UPDATE OF owner_email, shared_with ON albums
WHEN (new.owner_email IS NOT NULL AND new.owner_email <> lower(new.owner_email)) OR (new.shared_with IS NOT NULL AND new.shared_with <> lower(new.shared_with))
BEGIN SELECT RAISE(ABORT, 'emails on albums must be lowercase'); END;
