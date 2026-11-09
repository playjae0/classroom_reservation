-- Tokens are encrypted with TOKEN_ENCRYPTION_KEY before storage.
CREATE TABLE integration_tokens (
  provider TEXT PRIMARY KEY,
  encrypted_value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE integration_locks (
  provider TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
