-- Brute-force vector table used only in offline mode (tests and `npm run dev:offline`),
-- where Vectorize is not available. Production uses the Vectorize index.
CREATE TABLE offline_vectors (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  metadata   TEXT NOT NULL,
  vec        TEXT NOT NULL
);
CREATE INDEX idx_offline_vectors_user ON offline_vectors(user_id, kind);
