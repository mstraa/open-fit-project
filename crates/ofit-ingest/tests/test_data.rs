//! Integration test: parse the six bundled `/test-data` files (one effort each
//! in FIT/GPX/TCX) and assert each yields a recording with >0 streams and a
//! sane start < end window. Run with:
//!
//! ```text
//! cargo test -p ofit-ingest -- --nocapture
//! ```

use std::path::PathBuf;

use ofit_ingest::import_file;

/// Locate `<workspace>/test-data` relative to this crate.
fn test_data_dir() -> PathBuf {
    // CARGO_MANIFEST_DIR = <workspace>/crates/ofit-ingest
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("test-data")
}

#[test]
fn parses_all_test_data_files() {
    let dir = test_data_dir();
    let files = [
        "long-run.fit",
        "long-run.gpx",
        "long-run.tcx",
        "velo.fit",
        "velo.gpx",
        "velo.tcx",
    ];

    println!("\n=== ofit-ingest /test-data parse report ===");
    for f in files {
        let path = dir.join(f);
        let parsed = import_file(&path).unwrap_or_else(|e| panic!("import {f}: {e}"));
        let rec = &parsed.recording;

        // Invariants the dedup stage relies on.
        assert!(
            !parsed.streams.is_empty(),
            "{f}: expected >0 streams, got 0"
        );
        assert!(
            rec.started_at < rec.ended_at,
            "{f}: expected start < end ({} !< {})",
            rec.started_at,
            rec.ended_at
        );
        assert_eq!(
            rec.content_hash.0.len(),
            64,
            "{f}: content hash should be 64 hex chars (sha256), got {:?}",
            rec.content_hash.0
        );
        assert!(
            rec.content_hash.0.chars().all(|c| c.is_ascii_hexdigit()),
            "{f}: content hash must be lowercase hex"
        );
        // Every stream points at this recording.
        for s in &parsed.streams {
            assert_eq!(s.recording_id, rec.id, "{f}: stream recording_id mismatch");
        }

        let dur = rec.duration_secs();
        let format = rec.metadata.get("format").and_then(|v| v.as_str()).unwrap_or("?");
        let device = rec
            .metadata
            .get("device")
            .and_then(|v| v.as_str())
            .unwrap_or("-");

        println!(
            "\n{f}: format={format} sport={:?} duration={}s device={device}",
            rec.sport, dur
        );
        println!("  hash={}", rec.content_hash.0);
        let mut kinds: Vec<_> = parsed
            .streams
            .iter()
            .map(|s| format!("{:?}={}", s.kind, s.len()))
            .collect();
        kinds.sort();
        println!("  streams ({}): {}", parsed.streams.len(), kinds.join(", "));
    }

    // Cross-format dedup sanity: the three FILES per effort are different
    // formats, so their content hashes differ (exact dedup keys off bytes;
    // logical dedup is the next stage's job). Same effort => same sport.
    let run_sport = import_file(&dir.join("long-run.fit")).unwrap().recording.sport;
    let run_gpx_sport = import_file(&dir.join("long-run.gpx")).unwrap().recording.sport;
    let run_tcx_sport = import_file(&dir.join("long-run.tcx")).unwrap().recording.sport;
    assert_eq!(run_sport, run_gpx_sport);
    assert_eq!(run_sport, run_tcx_sport);

    println!("\n=== all 6 files parsed OK ===\n");
}
