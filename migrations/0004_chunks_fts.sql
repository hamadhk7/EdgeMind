-- Keyword index over document chunks for hybrid retrieval. Searchable as soon as a
-- chunk is written, while Vectorize applies new vectors asynchronously.
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text,
  chunk_id UNINDEXED,
  user_id UNINDEXED,
  tokenize = 'porter unicode61'
);

CREATE TRIGGER chunks_fts_insert AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts (text, chunk_id, user_id) VALUES (new.text, new.id, new.user_id);
END;

CREATE TRIGGER chunks_fts_delete AFTER DELETE ON chunks BEGIN
  DELETE FROM chunks_fts WHERE chunk_id = old.id;
END;

-- Backfill chunks written before this migration.
INSERT INTO chunks_fts (text, chunk_id, user_id) SELECT text, id, user_id FROM chunks;
