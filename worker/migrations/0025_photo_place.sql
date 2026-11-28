-- The town nearest to a photo's GPS position, resolved by the agent from a local list ("Town, CC"). NULL until
-- resolved, '' when no town is near. Additive only: one nullable column, no index, not part of the search text.
ALTER TABLE photos ADD COLUMN place TEXT;
