//! Read-only SQL escape hatch.
//!
//! For debugging, the typed tools are not always enough — sometimes you need
//! to look straight at the rows. This module runs **SELECT-only** statements
//! against the live database with layered guards:
//!
//! 1. **DB-level read-only enforcement** (the load-bearing one): every query
//!    runs on a dedicated connection (detached from the pool, closed after
//!    use) with `PRAGMA query_only = ON` (SQLite) or
//!    `SET default_transaction_read_only = on` (Postgres), so even a guard
//!    bypass cannot write;
//! 2. statement shape: must start with `SELECT`, `WITH`, or `EXPLAIN`, single
//!    statement only, plus a conservative keyword scan for write ops reachable
//!    inside a CTE (`WITH x AS (DELETE …) SELECT …`). The scan looks at raw
//!    words, so string literals can false-positive — acceptable for a debug
//!    tool and documented in the tool description;
//! 3. **auth tables are denied outright**: `users` (password hashes) and
//!    `sessions` (live bearer tokens) must never flow into an LLM context —
//!    a prompt-injected model steered into `SELECT token FROM sessions` would
//!    otherwise exfiltrate working credentials;
//! 4. rows are *streamed* with a row cap, a per-cell byte cap, and a total
//!    response budget — a `SELECT zeroblob(2e9)` must not OOM the server, and
//!    a wide result must not flood the model context.
//!
//! Cells decode through the sqlx `Any` driver, which is strict per backend:
//! SQLite stores everything as TEXT/INTEGER/REAL (this codebase's portability
//! rule), Postgres returns native types. We probe `String → i64 → f64 → bool`
//! per column and fall back to an explicit `<undecoded:TYPE>` marker rather
//! than erroring the whole row (Postgres `NUMERIC`/`BYTEA`/`JSONB` land
//! there).

use futures_util::TryStreamExt;
use ofit_db::{Backend, Db};
use serde_json::{json, Map, Value};
use sqlx::any::AnyRow;
use sqlx::{Column, Row, TypeInfo};

use crate::error::Result;

/// Write/DDL keywords reachable despite the leading-keyword + single-statement
/// guards — chiefly data-modifying CTEs. Deliberately NOT listed: `replace`,
/// `set`, `copy`, `begin`, `commit`, `rollback` — `REPLACE()` is a standard
/// read-only string function, and the rest are only writes as *leading*
/// keywords (already rejected) while being legitimate column identifiers.
/// The DB-level read-only guard backstops anything this scan misses.
const FORBIDDEN: &[&str] = &[
    "insert", "update", "delete", "merge", "drop", "alter", "create", "attach", "detach",
    "pragma", "vacuum", "reindex", "truncate", "grant", "revoke",
];

/// Tables holding credentials/bearer tokens (migrations/0002_auth.sql) — never
/// readable through this hatch: their contents must not enter an LLM context.
const FORBIDDEN_TABLES: &[&str] = &["users", "sessions"];

/// Per-cell byte cap: bounds pathological single-row values
/// (`SELECT zeroblob(2000000000)`) without affecting real rows.
const MAX_CELL_BYTES: usize = 64 * 1024;

/// Total decoded-bytes budget per query — mirrors the dispatch layer's
/// response cap so query_sql (which bypasses dispatch) has the same ceiling.
const MAX_TOTAL_BYTES: usize = 4 * 1024 * 1024;

/// Validate that `sql` is a single read-only statement that avoids the auth
/// tables. Returns the trimmed statement or a human-readable rejection.
pub(crate) fn validate_readonly(sql: &str) -> std::result::Result<String, String> {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    if trimmed.is_empty() {
        return Err("empty SQL statement".into());
    }
    if trimmed.contains(';') {
        return Err("multiple statements are not allowed (found ';')".into());
    }
    let lower = trimmed.to_lowercase();
    let first = lower.split_whitespace().next().unwrap_or("");
    if !matches!(first, "select" | "with" | "explain") {
        return Err(format!(
            "only SELECT/WITH/EXPLAIN statements are allowed (got '{first}')"
        ));
    }
    // Word-boundary scan over the whole statement, string literals included —
    // conservative by design.
    let mut word = String::new();
    for c in lower.chars().chain(std::iter::once(' ')) {
        if c.is_ascii_alphanumeric() || c == '_' {
            word.push(c);
        } else if !word.is_empty() {
            if FORBIDDEN.contains(&word.as_str()) {
                return Err(format!(
                    "forbidden keyword '{word}' — this tool is strictly read-only \
                     (note: the scan includes string literals; rephrase if it hit one)"
                ));
            }
            if FORBIDDEN_TABLES.contains(&word.as_str()) {
                return Err(format!(
                    "table '{word}' is not readable via query_sql \
                     (credentials/session tokens must not enter the model context)"
                ));
            }
            word.clear();
        }
    }
    Ok(trimmed.to_string())
}

/// Run a validated read-only statement, streaming at most `limit` rows on a
/// dedicated read-only connection.
pub(crate) async fn run_query(db: &Db, sql: &str, limit: usize) -> Result<Value> {
    // Detach a connection from the pool: the read-only setting is
    // per-connection, and detaching guarantees it can never leak back into the
    // pool where the app's writes would start failing. The connection closes
    // on drop; the pool replenishes itself.
    let mut conn = db.pool().acquire().await?.detach();

    // Belt: enforce read-only at the engine level (the keyword scan is only
    // a fast-fail heuristic).
    match db.backend() {
        Backend::Sqlite => {
            sqlx::query("PRAGMA query_only = ON").execute(&mut conn).await?;
        }
        Backend::Postgres => {
            sqlx::query("SET default_transaction_read_only = on")
                .execute(&mut conn)
                .await?;
        }
        Backend::Other => {}
    }

    let mut stream = sqlx::query(sql).fetch(&mut conn);
    let mut columns: Vec<String> = Vec::new();
    let mut rows: Vec<Value> = Vec::new();
    let mut truncated = false;
    let mut budget = MAX_TOTAL_BYTES;

    while let Some(row) = stream.try_next().await? {
        if columns.is_empty() {
            columns = row.columns().iter().map(|c| c.name().to_string()).collect();
        }
        if rows.len() >= limit || budget == 0 {
            truncated = true;
            break;
        }
        let cells: Vec<Value> = (0..row.columns().len()).map(|i| decode_cell(&row, i)).collect();
        // Approximate the serialized size to keep the aggregate bounded even
        // when every cell is just under the per-cell cap.
        let row_bytes: usize = cells
            .iter()
            .map(|c| c.as_str().map(str::len).unwrap_or(24))
            .sum();
        budget = budget.saturating_sub(row_bytes);
        rows.push(Value::Array(cells));
    }

    Ok(json!({
        "columns": columns,
        "rows": rows,
        "row_count": rows.len(),
        "truncated": truncated,
    }))
}

/// Decode one cell by probing the portable types in order. NULL decodes via
/// the first probe; an undecodable native type yields a marker, not an error.
/// Oversized text is truncated on a char boundary with an explicit marker.
fn decode_cell(row: &AnyRow, i: usize) -> Value {
    if let Ok(v) = row.try_get::<Option<String>, _>(i) {
        return match v {
            Some(s) if s.len() > MAX_CELL_BYTES => {
                let mut end = MAX_CELL_BYTES;
                while !s.is_char_boundary(end) {
                    end -= 1;
                }
                Value::String(format!("{}…<truncated, {} bytes total>", &s[..end], s.len()))
            }
            Some(s) => Value::String(s),
            None => Value::Null,
        };
    }
    if let Ok(v) = row.try_get::<Option<i64>, _>(i) {
        return v.map(Value::from).unwrap_or(Value::Null);
    }
    if let Ok(v) = row.try_get::<Option<f64>, _>(i) {
        return v.map(Value::from).unwrap_or(Value::Null);
    }
    if let Ok(v) = row.try_get::<Option<bool>, _>(i) {
        return v.map(Value::Bool).unwrap_or(Value::Null);
    }
    Value::String(format!("<undecoded:{}>", row.column(i).type_info().name()))
}

/// Backend-aware schema introspection: table/view DDL on SQLite, grouped
/// `information_schema.columns` on Postgres.
pub(crate) async fn schema(db: &Db) -> Result<Value> {
    match db.backend() {
        Backend::Sqlite => {
            let rows = sqlx::query(
                "SELECT name, sql FROM sqlite_master \
                 WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .fetch_all(db.pool())
            .await?;
            let tables: Vec<Value> = rows
                .iter()
                .map(|r| {
                    json!({
                        "name": r.try_get::<String, _>(0).unwrap_or_default(),
                        "ddl": r.try_get::<Option<String>, _>(1).ok().flatten(),
                    })
                })
                .collect();
            Ok(json!({ "backend": "sqlite", "tables": tables }))
        }
        Backend::Postgres => {
            let rows = sqlx::query(
                "SELECT table_name, column_name, data_type, is_nullable \
                 FROM information_schema.columns WHERE table_schema = 'public' \
                 ORDER BY table_name, ordinal_position",
            )
            .fetch_all(db.pool())
            .await?;
            // Group columns under their table, preserving order.
            let mut tables: Map<String, Value> = Map::new();
            for r in &rows {
                let table: String = r.try_get(0).unwrap_or_default();
                let col = json!({
                    "name": r.try_get::<String, _>(1).unwrap_or_default(),
                    "type": r.try_get::<String, _>(2).unwrap_or_default(),
                    "nullable": r.try_get::<String, _>(3).unwrap_or_default() == "YES",
                });
                tables
                    .entry(table)
                    .or_insert_with(|| Value::Array(vec![]))
                    .as_array_mut()
                    .expect("inserted as array")
                    .push(col);
            }
            Ok(json!({ "backend": "postgres", "tables": tables }))
        }
        Backend::Other => Ok(json!({
            "backend": "other",
            "error": "schema introspection is only implemented for SQLite and Postgres",
        })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_plain_selects_and_ctes() {
        assert!(validate_readonly("SELECT * FROM activities LIMIT 5").is_ok());
        assert!(validate_readonly("  with t as (select 1) select * from t; ").is_ok());
        assert!(validate_readonly("EXPLAIN SELECT count(*) FROM sources").is_ok());
    }

    // REPLACE() the string function (and columns named set/copy) are read-only
    // and must pass — the old over-broad list rejected them.
    #[test]
    fn accepts_readonly_builtins_previously_false_positive() {
        assert!(validate_readonly("SELECT replace(name,'a','b') FROM sources").is_ok());
        assert!(validate_readonly("SELECT 1 AS \"set\" FROM activities").is_ok());
    }

    #[test]
    fn rejects_writes_multistatement_and_modifying_ctes() {
        assert!(validate_readonly("DELETE FROM activities").is_err());
        assert!(validate_readonly("SELECT 1; DROP TABLE activities").is_err());
        assert!(validate_readonly("WITH d AS (DELETE FROM x RETURNING *) SELECT * FROM d").is_err());
        assert!(validate_readonly("PRAGMA journal_mode=DELETE").is_err());
        assert!(validate_readonly("").is_err());
    }

    // Credentials must never be selectable: sessions holds live bearer tokens,
    // users holds password hashes.
    #[test]
    fn rejects_auth_tables() {
        assert!(validate_readonly("SELECT token FROM sessions").is_err());
        assert!(validate_readonly("SELECT password_hash FROM users").is_err());
        assert!(validate_readonly("WITH s AS (SELECT * FROM sessions) SELECT 1").is_err());
    }

    // Documented false positive: forbidden words inside string literals.
    #[test]
    fn keyword_scan_is_conservative_about_string_literals() {
        assert!(validate_readonly("SELECT * FROM x WHERE note = 'please delete me'").is_err());
    }
}
