//! Phase-1 fil rouge: import all /test-data files into a fresh SQLite db and
//! assert the dedup/fusion invariants.
//!
//! The files are 2 efforts: one RUN recorded by several devices/formats (Stryd
//! FIT + Zepp FIT/GPX/TCX) and one bike RIDE (Garmin FIT/GPX/TCX). They must
//! collapse to exactly 2 activities (1 Running, 1 Cycling), and re-importing a
//! file must be a no-op (exact-hash dedup). The run mixes two real devices
//! (Garmin Forerunner 945 via Stryd export + Zepp) → distinct sources.

use std::path::{Path, PathBuf};

use ofit_core::{resolve_activity_view, Sport};
use ofit_db::Db;
use ofit_ingest::{import_path, ImportOutcome};

fn test_data_dir() -> PathBuf {
    // crate dir is .../crates/ofit-ingest; test-data is at the repo root.
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test-data")
        .canonicalize()
        .expect("test-data dir")
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

#[tokio::test]
async fn imports_files_into_two_activities_with_exact_dedup() {
    let dir = test_data_dir();

    // Fresh on-disk SQLite in a temp dir (the pool opens several connections, so
    // a pure `:memory:` db would be invisible across them; a file is shared).
    let tmp = std::env::temp_dir().join(format!("ofit-test-{}.db", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    let url = format!("sqlite://{}?mode=rwc", tmp.display());
    let db = Db::connect(&url).await.expect("connect");
    db.run_migrations().await.expect("migrate");

    // Import all 6 files.
    for f in FILES {
        let outcome = import_path(&db, &dir.join(f)).await.expect("import");
        assert!(
            matches!(outcome, ImportOutcome::Imported { .. }),
            "{f} should import fresh, got {outcome:?}"
        );
    }

    let n_files = FILES.len() as i64;
    // All raw recordings persisted (one per file).
    assert_eq!(db.count_recordings().await.unwrap(), n_files, "raw_recordings");

    // Exactly 2 activities.
    let activities = db.list_activities().await.unwrap();
    assert_eq!(activities.len(), 2, "activities");
    assert_eq!(db.count_activities().await.unwrap(), 2);

    // 1 Running (4 recordings: Stryd FIT + Zepp FIT/GPX/TCX), 1 Cycling (3).
    let run = activities
        .iter()
        .find(|a| a.sport == Sport::Running)
        .expect("a running activity");
    let ride = activities
        .iter()
        .find(|a| a.sport == Sport::Cycling)
        .expect("a cycling activity");
    assert_eq!(run.recording_ids.len(), 4, "running recordings");
    assert_eq!(ride.recording_ids.len(), 3, "cycling recordings");

    // The run mixes two distinct real devices → ≥2 sources for the run.
    let sources = db.list_sources().await.unwrap();
    let names: std::collections::BTreeSet<_> = sources.iter().map(|s| s.name.as_str()).collect();
    assert!(
        names.contains("Garmin Forerunner 945"),
        "expected a Garmin Forerunner 945 source, got {names:?}"
    );
    assert!(
        names.contains("Zepp"),
        "expected a Zepp source, got {names:?}"
    );

    // Re-importing every file is a no-op (exact-hash dedup), counts unchanged.
    for f in FILES {
        let outcome = import_path(&db, &dir.join(f)).await.expect("re-import");
        assert!(
            matches!(outcome, ImportOutcome::Duplicate { .. }),
            "{f} re-import should dedup, got {outcome:?}"
        );
    }
    assert_eq!(db.count_recordings().await.unwrap(), n_files, "no dup recordings");
    assert_eq!(db.count_activities().await.unwrap(), 2, "no dup activities");

    // Resolved canonical view works end-to-end: with no preferences, each metric
    // resolves to some source via priority fallback, one stream per kind.
    let recs = db.recording_ids_for_activity(run.id).await.unwrap();
    let mut all_streams = Vec::new();
    for rid in &recs {
        all_streams.extend(db.streams_for_recording(*rid).await.unwrap());
    }
    let sources = db.list_sources().await.unwrap();
    let rec_src = db.recording_sources(&recs).await.unwrap();
    let prefs = db.preferences_for_activity(run.id).await.unwrap();
    let view = resolve_activity_view(run, &all_streams, &sources, &rec_src, &prefs);
    assert!(!view.metrics.is_empty(), "resolved view has metrics");
    // One resolved stream per distinct kind.
    let mut kinds: Vec<_> = view.metrics.iter().map(|m| m.kind).collect();
    let n = kinds.len();
    kinds.dedup();
    assert_eq!(kinds.len(), n, "one resolved stream per metric kind");

    let _ = std::fs::remove_file(&tmp);
}
