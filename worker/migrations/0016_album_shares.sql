ALTER TABLE albums ADD COLUMN owner_email TEXT;
ALTER TABLE albums ADD COLUMN shared_with TEXT;
-- Makes owner_email = ? lookups index searches.
CREATE INDEX IF NOT EXISTS idx_albums_owner_email ON albums (owner_email) WHERE owner_email IS NOT NULL;
-- Emails are always stored lowercase and compared exactly: the database refuses anything else, so no query needs lower().
CREATE TRIGGER IF NOT EXISTS albums_emails_lower_bi BEFORE INSERT ON albums
WHEN (new.owner_email IS NOT NULL AND new.owner_email <> lower(new.owner_email)) OR (new.shared_with IS NOT NULL AND new.shared_with <> lower(new.shared_with))
BEGIN SELECT RAISE(ABORT, 'emails on albums must be lowercase'); END;
CREATE TRIGGER IF NOT EXISTS albums_emails_lower_bu BEFORE UPDATE OF owner_email, shared_with ON albums
WHEN (new.owner_email IS NOT NULL AND new.owner_email <> lower(new.owner_email)) OR (new.shared_with IS NOT NULL AND new.shared_with <> lower(new.shared_with))
BEGIN SELECT RAISE(ABORT, 'emails on albums must be lowercase'); END;
-- People are per owner (owner = creator). NULL until backfilled (npm run backfill-owner); NULLs never collide in the unique index.
ALTER TABLE persons ADD COLUMN owner_email TEXT;
-- Replaces the global name index (0009): names are unique per owner, case-insensitively. Dropping an index is metadata-only.
DROP INDEX IF EXISTS idx_persons_name_lower;
CREATE UNIQUE INDEX IF NOT EXISTS idx_persons_owner_name_lower ON persons (owner_email, lower(name));
CREATE TRIGGER IF NOT EXISTS persons_owner_lower_bi BEFORE INSERT ON persons
WHEN new.owner_email IS NOT NULL AND new.owner_email <> lower(new.owner_email)
BEGIN SELECT RAISE(ABORT, 'emails on persons must be lowercase'); END;
CREATE TRIGGER IF NOT EXISTS persons_owner_lower_bu BEFORE UPDATE OF owner_email ON persons
WHEN new.owner_email IS NOT NULL AND new.owner_email <> lower(new.owner_email)
BEGIN SELECT RAISE(ABORT, 'emails on persons must be lowercase'); END;
