ALTER TABLE albums ADD COLUMN owner_email TEXT;
ALTER TABLE albums ADD COLUMN shared_with TEXT;
-- Makes the default-owner "does any album have an owner" probe and owner_email = ? lookups index searches.
CREATE INDEX IF NOT EXISTS idx_albums_owner_email ON albums (owner_email) WHERE owner_email IS NOT NULL;
