//! In-process dispatch into the REST API.
//!
//! The MCP server is a *thin layer over the API* (PLAN.md Phase 8): tools do
//! not reimplement handler logic, they drive the very same axum router the
//! HTTP API serves — minus the auth `route_layer`, because auth is enforced
//! once at the `/mcp` ingress. Each tool call builds a synthetic
//! `http::Request`, `oneshot`s it through a clone of the router, and parses
//! the JSON response. No network hop, no logic duplication, and every future
//! endpoint is immediately wrappable.

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use axum::Router;
use rmcp::model::{CallToolResult, Content};
use rmcp::ErrorData as McpError;
use serde_json::Value;
use tower::ServiceExt;

use crate::error::{McpServeError, Result};

/// Hard cap when collecting a dispatched response body. The unbounded
/// endpoints (`/wellness` over years of minute-level samples) can reach tens
/// of MB; we allow a heavy pull (the MCP layer downsamples before the LLM
/// sees it) but bound memory so a runaway query cannot OOM the server.
const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;

/// A dispatched API response: status + parsed JSON body.
pub(crate) struct ApiResponse {
    pub status: StatusCode,
    pub body: Value,
}

/// Drives synthetic requests through the pre-auth API router.
#[derive(Clone)]
pub(crate) struct Dispatcher {
    /// `Router<()>` clone of the protected API (state applied, auth stripped).
    /// Paths are relative to the `/api` nest (e.g. `/activities`).
    router: Router,
}

impl Dispatcher {
    pub fn new(router: Router) -> Self {
        Self { router }
    }

    /// Dispatch `method path_and_query` (path relative to `/api`), with an
    /// optional JSON body, and collect the JSON response.
    pub async fn call(
        &self,
        method: Method,
        path_and_query: &str,
        body: Option<&Value>,
    ) -> Result<ApiResponse> {
        let mut builder = Request::builder().method(method).uri(path_and_query);
        let body = match body {
            Some(json) => {
                builder = builder.header(header::CONTENT_TYPE, "application/json");
                Body::from(serde_json::to_vec(json)?)
            }
            None => Body::empty(),
        };
        let request = builder.body(body)?;

        // Router's Service impl is infallible; oneshot consumes the service,
        // hence the per-call clone (Routers clone cheaply, Arc inside).
        let response = self
            .router
            .clone()
            .oneshot(request)
            .await
            .expect("axum router dispatch is infallible");

        let status = response.status();
        // The dispatched body is a fully-buffered `Json` (the router is
        // infallible), so the only failure mode here is the length cap.
        let bytes = axum::body::to_bytes(response.into_body(), MAX_RESPONSE_BYTES)
            .await
            .map_err(|_| McpServeError::ResponseTooLarge(MAX_RESPONSE_BYTES / (1024 * 1024)))?;

        // Empty bodies (204s etc.) and the rare non-JSON payload both degrade
        // gracefully instead of failing the tool call.
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()))
        };

        Ok(ApiResponse { status, body })
    }
}

/// Convert a dispatched response into a tool result: 2xx → JSON content,
/// anything else → a *tool-level* error the LLM can read and react to
/// (`{"error": …}` bodies come through verbatim).
pub(crate) fn into_tool_result(resp: ApiResponse) -> std::result::Result<CallToolResult, McpError> {
    if resp.status.is_success() {
        Ok(CallToolResult::success(vec![Content::json(resp.body)?]))
    } else {
        Ok(CallToolResult::error(vec![Content::text(format!(
            "API error (HTTP {}): {}",
            resp.status.as_u16(),
            resp.body
        ))]))
    }
}

/// Map an infrastructure failure to a protocol-level MCP error.
pub(crate) fn internal(e: McpServeError) -> McpError {
    McpError::internal_error(e.to_string(), None)
}

/// Route a dispatch failure: an over-cap response becomes a *tool-level* error
/// with recovery guidance (the model can narrow its query); everything else is
/// a genuine protocol-level internal error.
pub(crate) fn failure_result(e: McpServeError) -> std::result::Result<CallToolResult, McpError> {
    match e {
        McpServeError::ResponseTooLarge(cap_mib) => {
            Ok(CallToolResult::error(vec![Content::text(format!(
                "API response exceeded the {cap_mib} MiB cap before downsampling — \
                 narrow the time window (smaller from..to) or lower the page size, then retry."
            ))]))
        }
        other => Err(internal(other)),
    }
}

/// Build `path?k=v&…` with proper percent-encoding (RFC3339 timestamps carry
/// `+` and `:`, which would otherwise be mangled in a query string).
pub(crate) fn with_query(path: &str, params: &[(&str, String)]) -> String {
    if params.is_empty() {
        return path.to_string();
    }
    let qs = serde_urlencoded::to_string(params).expect("string pairs always encode");
    format!("{path}?{qs}")
}

/// Uniform stride-downsample of a JSON array, always keeping first and last —
/// the same strategy the API itself uses for chart payloads. Returns the
/// original length.
pub(crate) fn stride_sample(points: &mut Value, max: usize) -> usize {
    let Some(arr) = points.as_array_mut() else {
        return 0;
    };
    let len = arr.len();
    if len <= max || max < 2 {
        return len;
    }
    let picked: Vec<Value> = (0..max)
        .map(|i| arr[i * (len - 1) / (max - 1)].clone())
        .collect();
    *arr = picked;
    len
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // The stride sampler must keep endpoints and never exceed the cap.
    #[test]
    fn stride_sample_keeps_first_and_last_and_caps_length() {
        let mut v = json!((0..1000).collect::<Vec<_>>());
        let original = stride_sample(&mut v, 100);
        let arr = v.as_array().unwrap();
        assert_eq!(original, 1000);
        assert_eq!(arr.len(), 100);
        assert_eq!(arr[0], json!(0));
        assert_eq!(arr[99], json!(999));
    }

    // Short arrays pass through untouched.
    #[test]
    fn stride_sample_is_identity_when_under_cap() {
        let mut v = json!([1, 2, 3]);
        let original = stride_sample(&mut v, 100);
        assert_eq!(original, 3);
        assert_eq!(v.as_array().unwrap().len(), 3);
    }

    // Timestamps with offsets survive query encoding.
    #[test]
    fn with_query_percent_encodes_rfc3339() {
        let q = with_query("/wellness", &[("from", "2026-06-01T00:00:00+02:00".into())]);
        assert_eq!(q, "/wellness?from=2026-06-01T00%3A00%3A00%2B02%3A00");
    }
}
