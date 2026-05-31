-- Generic app settings: a small key/value store for user preferences that should
-- follow the account/server rather than living in one device's localStorage
-- (e.g. the daily step goal). Single-user self-hosted, so settings are global.

CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
