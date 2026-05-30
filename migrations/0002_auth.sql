-- Open Fit — single-user auth (Phase 1 tie-off).
--
-- PORTABILITY: same rules as 0001 — TEXT / INTEGER only, ISO-8601 TEXT
-- timestamps, app-generated UUID ids. Runs verbatim on SQLite and Postgres.

-- The account(s). Single-user today, but a table keeps multi-user open later.
CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL,
    password_hash TEXT NOT NULL,          -- argon2 PHC string
    created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_users_username ON users (username);

-- Server-side sessions: a random opaque token in an http-only cookie maps here.
-- Survives restarts (no signing secret to manage); logout/expiry just delete rows.
CREATE TABLE sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL              -- ISO-8601; lexicographic compare works
);
CREATE INDEX ix_sessions_user ON sessions (user_id);
CREATE INDEX ix_sessions_expiry ON sessions (expires_at);
