use chrono::Utc;
use ofit_core::{RawRecording, Source, SourceKind, WellnessKind, WellnessSample, ContentHash, Sport};
use ofit_db::Db;
use uuid::Uuid;

#[tokio::test]
async fn migrates_and_roundtrips_on_sqlite() {
    let url = "sqlite::memory:";
    let db = Db::connect(url).await.expect("connect");
    db.run_migrations().await.expect("migrate");

    let src = Source::new(SourceKind::Device, "Garmin 945", 100);
    let sid = src.id;
    db.insert_source(&src).await.expect("insert source");
    assert_eq!(db.get_source_name(sid).await.unwrap().as_deref(), Some("Garmin 945"));

    let rec = RawRecording {
        id: Uuid::new_v4(),
        source_id: sid,
        content_hash: ContentHash::of_bytes(b"hello"),
        sport: Sport::Running,
        started_at: Utc::now(),
        ended_at: Utc::now(),
        metadata: serde_json::json!({"file":"x.fit"}),
        ingested_at: Utc::now(),
    };
    db.insert_recording(&rec).await.expect("insert recording");

    for i in 0..5 {
        let w = WellnessSample::scalar(sid, WellnessKind::HeartRate, 60.0 + i as f64, Utc::now());
        db.insert_wellness_sample(&w).await.expect("insert wellness");
    }
    assert_eq!(db.count_wellness_samples().await.unwrap(), 5);
}
