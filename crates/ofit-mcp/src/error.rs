//! Infrastructure errors for the MCP layer.
//!
//! These cover the plumbing only (in-process dispatch, SQL execution). API
//! responses with non-2xx statuses are NOT errors here — they are surfaced to
//! the LLM as readable tool results (`CallToolResult::error`), so the model can
//! react to a 404 or a validation message instead of seeing an aborted RPC.

/// Failure inside the MCP plumbing (never a domain/API-level failure).
#[derive(Debug, thiserror::Error)]
pub enum McpServeError {
    /// Building the synthetic dispatch request failed (bad method/uri/body).
    #[error("failed to build dispatch request: {0}")]
    Request(#[from] axum::http::Error),

    /// The dispatched response body exceeded the collection cap. Surfaced to
    /// the LLM as a readable tool error ("narrow the window"), never as an
    /// aborted RPC — the model must be able to react by re-querying smaller.
    #[error("API response exceeded the {0} MiB cap")]
    ResponseTooLarge(usize),

    /// The response body was not valid JSON (only binary endpoints do this,
    /// and those are blocked from dispatch).
    #[error("API returned non-JSON response: {0}")]
    Json(#[from] serde_json::Error),

    /// The read-only SQL tool hit a database error.
    #[error("database error: {0}")]
    Sql(#[from] sqlx::Error),
}

/// Convenience alias used throughout the crate.
pub type Result<T> = std::result::Result<T, McpServeError>;
