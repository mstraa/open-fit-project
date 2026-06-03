//! Regression guard for the SQLite↔Postgres placeholder rewrite.
//!
//! Every SQL string that contains a `?` placeholder must be passed through
//! `Db::p()` (which rewrites `?` → `$n` on Postgres). A raw `sqlx::query("…")`
//! is fine ONLY when its literal carries no `?`. Forgetting `.p()` on a new
//! query compiles and works on SQLite but silently breaks on Postgres — and the
//! Postgres path has no local test coverage. This conservative source scan
//! catches exactly that mistake at `cargo test` time, without a live database.
//!
//! It flags a raw query *string literal* containing `?`. Queries wrapped in
//! `self.p(...)` or a pre-rewritten local (`&self.p(`, `&rewritten`, `&sql`) are
//! correct by construction and skipped.

const SRC: &str = include_str!("../src/lib.rs");

#[test]
fn no_placeholder_query_skips_p() {
    const NEEDLE: &str = "sqlx::query(";
    let mut offenders: Vec<usize> = Vec::new();
    let mut search = 0usize;

    while let Some(rel) = SRC[search..].find(NEEDLE) {
        let at = search + rel;
        search = at + NEEDLE.len();
        let rest = SRC[search..].trim_start();

        // Wrapped / pre-rewritten forms are correct by construction.
        if rest.starts_with("&self.p(") || rest.starts_with("&rewritten") || rest.starts_with("&sql") {
            continue;
        }

        // Otherwise expect a raw string literal: sqlx::query("…"). Read the literal
        // (honoring \" escapes) and flag it if it carries a `?` placeholder.
        if let Some(open) = rest.find('"') {
            let lit = &rest[open + 1..];
            let mut escaped = false;
            let mut has_placeholder = false;
            for ch in lit.chars() {
                if escaped {
                    escaped = false;
                    continue;
                }
                match ch {
                    '\\' => escaped = true,
                    '"' => break,
                    '?' => has_placeholder = true,
                    _ => {}
                }
            }
            if has_placeholder {
                let line = SRC[..at].bytes().filter(|&b| b == b'\n').count() + 1;
                offenders.push(line);
            }
        }
    }

    assert!(
        offenders.is_empty(),
        "raw sqlx::query(\"…?…\") found — did you forget Db::p()? It won't rewrite \
         `?`→`$n` on Postgres. Wrap the SQL in self.p(...). Offending line(s): {offenders:?}"
    );
}
