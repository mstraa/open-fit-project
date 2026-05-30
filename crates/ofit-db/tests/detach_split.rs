//! Durable manual-split integration test (ofit-db + ofit-core).
//!
//! Two overlapping recordings cluster into ONE activity. Detaching one must
//! yield TWO activities (1 recording each), both `user_confirmed`, with the raw
//! recordings preserved. Re-running clustering while respecting the confirmed
//! groupings must KEEP them split (no auto-merge back).

use chrono::{Duration, TimeZone, Utc};
use ofit_core::{
    cluster_recordings, cluster_recordings_respecting, Activity, ContentHash, RawRecording, Source,
    SourceKind, Sport,
};
use ofit_db::Db;
use uuid::Uuid;

async fn fresh_db() -> Db {
    let dir = std::env::temp_dir().join(format!("ofit-detach-{}", Uuid::new_v4()));
    let url = format!("sqlite://{}/ofit.db?mode=rwc", dir.display());
    let db = Db::connect(&url).await.expect("connect");
    db.run_migrations().await.expect("migrate");
    db
}

fn rec(id: Uuid, source_id: Uuid, start_min: i64, dur_min: i64) -> RawRecording {
    let started = Utc.with_ymd_and_hms(2024, 1, 1, 8, 0, 0).unwrap() + Duration::minutes(start_min);
    RawRecording {
        id,
        source_id,
        content_hash: ContentHash(format!("{:064x}", id.as_u128())),
        sport: Sport::Running,
        started_at: started,
        ended_at: started + Duration::minutes(dur_min),
        metadata: serde_json::json!({"device": "test"}),
        ingested_at: Utc::now(),
    }
}

#[tokio::test]
async fn detach_makes_durable_split() {
    let db = fresh_db().await;

    let src = Source::new(SourceKind::Device, "Test Device", 50);
    db.insert_source(&src).await.unwrap();

    // Two overlapping running recordings → one activity.
    let r1 = rec(Uuid::from_u128(1), src.id, 0, 30);
    let r2 = rec(Uuid::from_u128(2), src.id, 10, 30); // overlaps r1
    db.insert_recording(&r1).await.unwrap();
    db.insert_recording(&r2).await.unwrap();

    let clusters = cluster_recordings(&[r1.clone(), r2.clone()]);
    assert_eq!(clusters.len(), 1, "overlapping recordings cluster into one");
    let act = &clusters[0];
    db.upsert_activity(act).await.unwrap();
    db.set_activity_recordings(act.id, &act.recording_ids)
        .await
        .unwrap();
    assert_eq!(db.count_activities().await.unwrap(), 1);

    // Detach r2 → 2 activities, 1 recording each.
    let new_id = db
        .detach_recording_from_activity(act.id, r2.id)
        .await
        .expect("detach");
    assert_ne!(new_id, act.id);
    assert_eq!(db.count_activities().await.unwrap(), 2, "split into two");

    let original = db.get_activity(act.id).await.unwrap().unwrap();
    let detached = db.get_activity(new_id).await.unwrap().unwrap();
    assert_eq!(original.recording_ids, vec![r1.id]);
    assert_eq!(detached.recording_ids, vec![r2.id]);
    assert!(original.user_confirmed, "original is user_confirmed");
    assert!(detached.user_confirmed, "detached is user_confirmed");
    // Detached window tightened to its own recording.
    assert_eq!(detached.started_at, r2.started_at);
    assert_eq!(detached.ended_at, r2.ended_at);

    // Raw recordings are preserved (never lost).
    assert_eq!(db.count_recordings().await.unwrap(), 2);
    assert!(db.get_recording(r1.id).await.unwrap().is_some());
    assert!(db.get_recording(r2.id).await.unwrap().is_some());

    // Re-running clustering while RESPECTING the user-confirmed groupings keeps
    // them split (this is what the import pipeline does on re-import).
    let all = db.list_recordings().await.unwrap();
    let locked: Vec<Activity> = db
        .list_activities()
        .await
        .unwrap()
        .into_iter()
        .filter(|a| a.user_confirmed)
        .collect();
    assert_eq!(locked.len(), 2);
    let reclustered = cluster_recordings_respecting(&all, &locked);
    assert_eq!(
        reclustered.len(),
        2,
        "user-confirmed split survives re-clustering"
    );

    // Guard: detaching the now-only recording is a no-op (Conflict).
    let err = db
        .detach_recording_from_activity(new_id, r2.id)
        .await
        .unwrap_err();
    assert!(matches!(err, ofit_db::DbError::Conflict(_)));
    assert_eq!(db.count_activities().await.unwrap(), 2, "no orphan activity");
}
