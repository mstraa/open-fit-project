//! Crate-wide error type. Pure domain — no IO/DB errors here.

use thiserror::Error;

/// Errors raised by domain logic in `ofit-core`.
#[derive(Debug, Error)]
pub enum Error {
    /// A value failed an invariant (e.g. end before start).
    #[error("invalid {field}: {reason}")]
    Invalid {
        /// Field that failed validation.
        field: &'static str,
        /// Human-readable reason.
        reason: String,
    },

    /// Two recordings cannot be merged because their sports differ.
    #[error("sport mismatch: {a:?} vs {b:?}")]
    SportMismatch {
        /// Sport of the first recording.
        a: crate::recording::Sport,
        /// Sport of the second recording.
        b: crate::recording::Sport,
    },
}

/// Convenience result alias for domain operations.
pub type Result<T> = std::result::Result<T, Error>;
