//! Regression tests for the SQLite "database is locked" (SQLITE_BUSY) failures
//! seen when a large import (≈770k wellness rows) ran while the dashboard fired
//! many concurrent `/api/wellness` reads. Root cause: the per-connection
//! `busy_timeout` pragma was set once on the pool, so only one of the N pooled
//! connections actually had it — the rest defaulted to 0 and errored instantly
//! under contention. The fix sets the pragmas on *every* connection via
//! `after_connect`.

use chrono::{Duration, Utc};
use ofit_core::{SourceKind, WellnessKind, WellnessSample};
use ofit_db::Db;
use uuid::Uuid;

fn temp_db_url() -> String {
    let dir = std::env::temp_dir().join(format!("ofit-conc-{}", Uuid::new_v4()));
    format!("sqlite://{}/ofit.db?mode=rwc", dir.display())
}

/// Every connection the pool can hand out must carry busy_timeout=15000, not
/// just the first one. Acquire the full pool at once (forcing distinct
/// connections) and check each — this fails on the pre-fix code where only one
/// connection was configured.
#[tokio::test]
async fn busy_timeout_set_on_every_pooled_connection() {
    let db = Db::connect(&temp_db_url()).await.expect("connect");
    db.run_migrations().await.expect("migrate");

    let pool = db.pool();
    // Hold several connections simultaneously so the pool must open (and thus
    // run after_connect on) more than one.
    let mut conns = Vec::new();
    for _ in 0..5 {
        conns.push(pool.acquire().await.expect("acquire connection"));
    }
    for (i, c) in conns.iter_mut().enumerate() {
        let timeout: i64 = sqlx::query_scalar("PRAGMA busy_timeout")
            .fetch_one(&mut **c)
            .await
            .expect("query busy_timeout");
        assert_eq!(timeout, 15000, "pooled connection {i} must have busy_timeout=15000, got {timeout}");
        // WAL is what lets readers and the writer not block each other at all.
        let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
            .fetch_one(&mut **c)
            .await
            .expect("query journal_mode");
        assert_eq!(mode.to_lowercase(), "wal", "pooled connection {i} must be in WAL mode, got {mode}");
    }
}

/// The lock-holder in the field was the recompute worker handing `write_wellness`
/// a whole-history series in ONE call (body-battery over years of stress). That
/// must not hold the write lock long enough to starve a concurrent writer: a big
/// `insert_computed_wellness` runs alongside a second writer doing small writes,
/// and both must finish without "database is locked".
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn large_unchunked_write_interleaves_with_other_writer() {
    let db = Db::connect(&temp_db_url()).await.expect("connect");
    db.run_migrations().await.expect("migrate");
    let computed = db.ensure_source(SourceKind::Unknown, "Computed").await.expect("source");
    let device = db.ensure_source(SourceKind::Device, "device").await.expect("source");

    // Worker-style: one call with a large series (chunked internally now).
    let big = {
        let db = db.clone();
        tokio::spawn(async move {
            let base = Utc::now();
            let samples: Vec<WellnessSample> = (0..60_000i64)
                .map(|i| WellnessSample::scalar(computed, WellnessKind::BodyBattery, 50.0, base + Duration::seconds(i)))
                .collect();
            db.insert_computed_wellness(&samples).await.expect("large computed write must not lock");
        })
    };
    // A second writer issuing small writes meanwhile — these must get the lock
    // between the big write's chunks rather than timing out.
    let small = {
        let db = db.clone();
        tokio::spawn(async move {
            let base = Utc::now();
            for i in 0..200i64 {
                let s = WellnessSample::scalar(device, WellnessKind::HeartRate, 60.0, base + Duration::seconds(i));
                db.insert_wellness_samples(std::slice::from_ref(&s)).await.expect("small write must not lock");
                tokio::task::yield_now().await;
            }
        })
    };
    big.await.expect("big writer task");
    small.await.expect("small writer task");
}

/// A bulk write (mimicking an import) running concurrently with a storm of
/// reads must not error with "database is locked". With WAL + a real
/// per-connection busy_timeout the readers and the writer serialize gracefully;
/// before the fix the unconfigured connections would surface SQLITE_BUSY.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_bulk_write_and_reads_do_not_lock() {
    let db = Db::connect(&temp_db_url()).await.expect("connect");
    db.run_migrations().await.expect("migrate");
    let sid = db.ensure_source(SourceKind::Device, "stress-test").await.expect("source");

    // Writer: 30k samples in 5k chunks, just like the import handler.
    let writer = {
        let db = db.clone();
        tokio::spawn(async move {
            let base = Utc::now();
            let mut batch = Vec::with_capacity(5_000);
            for i in 0..30_000i64 {
                batch.push(WellnessSample::scalar(sid, WellnessKind::HeartRate, 60.0, base + Duration::seconds(i)));
                if batch.len() == 5_000 {
                    db.insert_wellness_samples(&batch).await.expect("bulk insert must not lock");
                    batch.clear();
                }
            }
        })
    };

    // Readers: hammer the same table while the writer runs.
    let mut readers = Vec::new();
    for _ in 0..8 {
        let db = db.clone();
        readers.push(tokio::spawn(async move {
            for _ in 0..40 {
                db.count_wellness_samples().await.expect("read must not lock");
                db.wellness_samples(WellnessKind::HeartRate, None, None).await.expect("range read must not lock");
                tokio::task::yield_now().await;
            }
        }));
    }

    writer.await.expect("writer task");
    for r in readers {
        r.await.expect("reader task");
    }
    assert_eq!(db.count_wellness_samples().await.unwrap(), 30_000);
}
