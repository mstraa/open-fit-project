//! Error type for the DB layer.

use thiserror::Error;

/// Errors from connecting, migrating, or querying the database.
#[derive(Debug, Error)]
pub enum DbError {
    /// sqlx query/connection error.
    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),

    /// Migration error.
    #[error("migration error: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),

    /// Configuration / setup problem (e.g. cannot create SQLite dir).
    #[error("config error: {0}")]
    Config(String),
}

/// Convenience result alias for DB operations.
pub type Result<T> = std::result::Result<T, DbError>;
