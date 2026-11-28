-- Dashboard insights: one cached result for each user and topic, replaced on a new day or a new version
-- (worker/src/insights/common.ts). Holds ids and numbers only, never photo rows or names. Additive only.
CREATE TABLE IF NOT EXISTS insights_cache (
  email TEXT NOT NULL,
  topic TEXT NOT NULL,
  day TEXT NOT NULL,
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (email, topic)
) WITHOUT ROWID;
