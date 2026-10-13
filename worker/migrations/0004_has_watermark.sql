-- NULL means unknown (photos indexed before this field existed).
ALTER TABLE photos ADD COLUMN has_watermark INTEGER;
