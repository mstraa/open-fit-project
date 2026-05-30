//! Phase-1 fil rouge: import all 6 /test-data files into a fresh SQLite db and
//! assert the dedup/fusion invariants.
//!
//! The 6 files are 2 efforts (run + ride) in 3 formats each. They must collapse
//! to exactly 2 activities (1 Running with 3 recordings, 1 Cycling with 3),
//! and re-importing a file must be a no-op (exact-hash dedup).

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
    "long-run.fit",
    "long-run.gpx",
    "long-run.tcx",
    "velo.fit",
    "velo.gpx",
    "velo.tcx",
];

#[tokio::test]
async fn imports_six_files_into_two_activities_with_exact_dedup() {
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

    // 6 raw recordings persisted.
    assert_eq!(db.count_recordings().await.unwrap(), 6, "raw_recordings");

    // Exactly 2 activities.
    let activities = db.list_activities().await.unwrap();
    assert_eq!(activities.len(), 2, "activities");
    assert_eq!(db.count_activities().await.unwrap(), 2);

    // 1 Running w/ 3 recordings, 1 Cycling w/ 3 recordings.
    let run = activities
        .iter()
        .find(|a| a.sport == Sport::Running)
        .expect("a running activity");
    let ride = activities
        .iter()
        .find(|a| a.sport == Sport::Cycling)
        .expect("a cycling activity");
    assert_eq!(run.recording_ids.len(), 3, "running recordings");
    assert_eq!(ride.recording_ids.len(), 3, "cycling recordings");

    // Re-importing every file is a no-op (exact-hash dedup), counts unchanged.
    for f in FILES {
        let outcome = import_path(&db, &dir.join(f)).await.expect("re-import");
        assert!(
            matches!(outcome, ImportOutcome::Duplicate { .. }),
            "{f} re-import should dedup, got {outcome:?}"
        );
    }
    assert_eq!(db.count_recordings().await.unwrap(), 6, "no dup recordings");
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
