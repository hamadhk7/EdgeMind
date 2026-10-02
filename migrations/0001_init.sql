-- EdgeMind relational schema (D1)

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('guest', 'key')),
  created_at  INTEGER NOT NULL
);

CREATE TABLE api_keys (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  name          TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  revoked_at    INTEGER
);

CREATE TABLE conversations (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  title       TEXT NOT NULL DEFAULT 'New conversation',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_conversations_user ON conversations(user_id, updated_at DESC);

-- Cross-conversation view of every subtask (the orchestrator keeps the live copy).
CREATE TABLE tasks (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL,
  conversation_id  TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  agent            TEXT NOT NULL,
  input            TEXT NOT NULL,
  status           TEXT NOT NULL,
  error            TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  completed_at     INTEGER
);
CREATE INDEX idx_tasks_run ON tasks(run_id);
CREATE INDEX idx_tasks_user ON tasks(user_id, created_at DESC);

CREATE TABLE documents (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  filename     TEXT NOT NULL,
  mime         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  r2_key       TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
  chunk_count  INTEGER NOT NULL DEFAULT 0,
  workflow_id  TEXT,
  error        TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_documents_user ON documents(user_id, created_at DESC);

-- Chunk ids double as Vectorize vector ids.
CREATE TABLE chunks (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL,
  idx          INTEGER NOT NULL,
  text         TEXT NOT NULL
);
CREATE INDEX idx_chunks_document ON chunks(document_id, idx);

CREATE TABLE usage (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  conversation_id  TEXT,
  agent            TEXT NOT NULL,
  provider         TEXT NOT NULL,
  model            TEXT NOT NULL,
  input_tokens     INTEGER NOT NULL,
  output_tokens    INTEGER NOT NULL,
  cost_usd         REAL NOT NULL,
  cached           INTEGER NOT NULL DEFAULT 0,
  latency_ms       INTEGER NOT NULL,
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_usage_user_day ON usage(user_id, created_at);

CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,
  action      TEXT NOT NULL,
  target      TEXT,
  meta_json   TEXT,
  ip          TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_audit_user ON audit_log(user_id, created_at DESC);
