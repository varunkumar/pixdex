-- Add model information fields
ALTER TABLE Photo
ADD COLUMN modelName TEXT;

ALTER TABLE Photo
ADD COLUMN modelVersion TEXT;

ALTER TABLE Photo
ADD COLUMN modelType TEXT;