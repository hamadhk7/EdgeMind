-- Documents can live in KV or R2, so the column name should not say R2.
ALTER TABLE documents RENAME COLUMN r2_key TO storage_key;
