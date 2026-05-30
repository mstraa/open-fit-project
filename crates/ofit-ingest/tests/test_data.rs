//! Integration test: parse the bundled `/test-data` files (one run recorded by
//! several devices + one bike ride, each in FIT/GPX/TCX) and assert each yields
//! a recording with >0 streams and a sane start < end window. Also prints the
//! per-file derived device name + the full list of extracted stream kinds with
//! sample counts. Run with:
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

const FILES: &[&str] = &[
    "RUN001-Stryd-export.fit",
    "RUN001-Zepp-App-Export.fit",
    "RUN001-Zepp-App-Export.gpx",
    "RUN001-Zepp-App-Export.tcx",
    "BIKE001-Garmin-Forerunner-945-Garmin-Connect-export.fit",
    "BIKE001-Garmin-Forerunner-945-Garmin-Connect-export.gpx",
    "BIKE001-Garmin-Forerunner-945-Garmin-Connect-export.tcx",
];

#[test]
fn parses_all_test_data_files() {
    let dir = test_data_dir();

    println!("\n=== ofit-ingest /test-data parse report ===");
    for f in FILES {
        let path = dir.join(f);
        let parsed = import_file(&path).unwrap_or_else(|e| panic!("import {f}: {e}"));
        let rec = &parsed.recording;

        // Invariants the dedup stage relies on.
        assert!(!parsed.streams.is_empty(), "{f}: expected >0 streams, got 0");
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
        for s in &parsed.streams {
            assert_eq!(s.recording_id, rec.id, "{f}: stream recording_id mismatch");
        }

        let dur = rec.duration_secs();
        let format = rec
            .metadata
            .get("format")
            .and_then(|v| v.as_str())
            .unwrap_or("?");
        let device = rec
            .metadata
            .get("device")
            .and_then(|v| v.as_str())
            .unwrap_or("-");
        let mfr = rec
            .metadata
            .get("manufacturer")
            .and_then(|v| v.as_str())
            .unwrap_or("-");

        println!(
            "\n{f}\n  format={format} sport={:?} duration={}s\n  device={device:?} manufacturer={mfr:?}",
            rec.sport, dur
        );
        let mut kinds: Vec<_> = parsed
            .streams
            .iter()
            .map(|s| format!("{:?}={}", s.kind, s.len()))
            .collect();
        kinds.sort();
        println!("  streams ({}): {}", parsed.streams.len(), kinds.join(", "));
    }

    // The Stryd FIT and Zepp FIT are the SAME run on DIFFERENT devices → they
    // must resolve to DIFFERENT device names (so multi-device fusion can pick a
    // source per metric). This is the core "fix both" assertion from the task.
    let stryd = import_file(&dir.join("RUN001-Stryd-export.fit")).unwrap();
    let zepp = import_file(&dir.join("RUN001-Zepp-App-Export.fit")).unwrap();
    let name = |p: &ofit_ingest::ParsedRecording| {
        p.recording
            .metadata
            .get("device")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    assert_eq!(name(&stryd), "Garmin Forerunner 945");
    assert_eq!(name(&zepp), "Zepp");
    assert_ne!(name(&stryd), name(&zepp), "same run must yield distinct devices");

    // The Stryd FIT carries running-dynamics streams; the basic Zepp FIT does not.
    use ofit_core::StreamKind::*;
    let stryd_kinds = stryd.stream_kinds();
    for k in [VerticalOscillation, GroundContactTime, FormPower, AirPower, LegSpringStiffness] {
        assert!(stryd_kinds.contains(&k), "Stryd FIT missing {k:?}");
    }

    println!("\n=== all {} files parsed OK ===\n", FILES.len());
}
