-- Invite-only access: people ask for access, the admin decides. Emails are stored lowercase and compared exactly.
CREATE TABLE IF NOT EXISTS access_requests (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','revoked')),
  created_at TEXT NOT NULL,
  decided_at TEXT
);
-- Serves the admin listing: WHERE status = ? ORDER BY created_at DESC LIMIT n.
CREATE INDEX IF NOT EXISTS idx_access_requests_status_created ON access_requests (status, created_at);
CREATE TRIGGER IF NOT EXISTS access_requests_email_lower_bi BEFORE INSERT ON access_requests
WHEN new.email <> lower(new.email)
BEGIN SELECT RAISE(ABORT, 'emails on access_requests must be lowercase'); END;
CREATE TRIGGER IF NOT EXISTS access_requests_email_lower_bu BEFORE UPDATE OF email ON access_requests
WHEN new.email <> lower(new.email)
BEGIN SELECT RAISE(ABORT, 'emails on access_requests must be lowercase'); END;
