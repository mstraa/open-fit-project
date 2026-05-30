//! FIT parser (Garmin `.fit`, incl. embedded Stryd developer fields).
//!
//! Uses the `fitparser` crate. We walk `Record` messages into per-kind streams
//! and read the sport from the `Sport`/`Session` message. Position fields are
//! semicircles → degrees via `deg = semicircles * (180 / 2^31)`.

use chrono::{DateTime, Local, Utc};
use fitparser::{FitDataRecord, Value};
use ofit_core::StreamKind;

use crate::{builder::RecordingBuilder, sport_from_str, Error};

const SEMICIRCLES_TO_DEGREES: f64 = 180.0 / 2_147_483_648.0; // 180 / 2^31

/// Parse FIT bytes into a [`RecordingBuilder`].
pub(crate) fn parse(name: &str, bytes: &[u8]) -> crate::Result<RecordingBuilder> {
    let records = fitparser::from_bytes(bytes).map_err(|e| Error::Parse {
        format: "fit",
        name: name.to_string(),
        reason: e.to_string(),
    })?;

    let mut b = RecordingBuilder::new(name);
    b.meta("parser", "fitparser");

    let mut sport_set = false;
    let mut device: Option<String> = None;

    for rec in &records {
        match format!("{:?}", rec.kind()).as_str() {
            "Record" => extract_record(&mut b, rec),
            "Sport" | "Session" if !sport_set => {
                if let Some(s) = field_str(rec, "sport") {
                    b.set_sport(sport_from_str(&s));
                    sport_set = true;
                }
            }
            "DeviceInfo" if device.is_none() => {
                // Prefer the named product, fall back to manufacturer.
                device = field_str(rec, "garmin_product")
                    .filter(|s| !s.is_empty())
                    .or_else(|| field_str(rec, "product_name"))
                    .or_else(|| field_str(rec, "manufacturer"));
            }
            _ => {}
        }
    }

    if let Some(dev) = device {
        b.meta("device", dev);
    }

    Ok(b)
}

/// Pull the metrics we care about out of a single `Record` message.
fn extract_record(b: &mut RecordingBuilder, rec: &FitDataRecord) {
    let Some(ts) = field_timestamp(rec, "timestamp") else {
        return; // No timestamp → cannot place the sample.
    };

    // Position: paired semicircle fields → degrees.
    let lat = field_f64(rec, "position_lat").map(|v| v * SEMICIRCLES_TO_DEGREES);
    let lng = field_f64(rec, "position_long").map(|v| v * SEMICIRCLES_TO_DEGREES);
    if let (Some(lat), Some(lng)) = (lat, lng) {
        b.push_latlng(ts, lat, lng);
    }

    push(b, rec, ts, StreamKind::HeartRate, &["heart_rate"]);
    // Stryd running power rides in the developer field "Power" (capitalized);
    // native cycling power is "power". Accept either (dedup by first match).
    push(b, rec, ts, StreamKind::Power, &["power", "Power"]);
    push(b, rec, ts, StreamKind::Cadence, &["cadence"]);
    push(
        b,
        rec,
        ts,
        StreamKind::Speed,
        &["enhanced_speed", "speed"],
    );
    push(
        b,
        rec,
        ts,
        StreamKind::Altitude,
        &["enhanced_altitude", "altitude"],
    );
    push(b, rec, ts, StreamKind::Distance, &["distance"]);
    push(b, rec, ts, StreamKind::Temperature, &["temperature"]);
}

/// Push the first present field name from `names` as a scalar for `kind`.
fn push(
    b: &mut RecordingBuilder,
    rec: &FitDataRecord,
    ts: DateTime<Utc>,
    kind: StreamKind,
    names: &[&str],
) {
    for name in names {
        if let Some(v) = field_f64(rec, name) {
            b.push_scalar(kind, ts, v);
            return;
        }
    }
}

fn field<'a>(rec: &'a FitDataRecord, name: &str) -> Option<&'a Value> {
    rec.fields()
        .iter()
        .find(|f| f.name() == name)
        .map(|f| f.value())
}

fn field_f64(rec: &FitDataRecord, name: &str) -> Option<f64> {
    match field(rec, name)? {
        Value::Invalid => None,
        v => value_f64(v),
    }
}

fn field_str(rec: &FitDataRecord, name: &str) -> Option<String> {
    match field(rec, name)? {
        Value::String(s) => Some(s.clone()),
        Value::Invalid => None,
        other => Some(other.to_string()),
    }
}

fn field_timestamp(rec: &FitDataRecord, name: &str) -> Option<DateTime<Utc>> {
    match field(rec, name)? {
        Value::Timestamp(local) => Some(local_to_utc(*local)),
        _ => None,
    }
}

fn local_to_utc(local: DateTime<Local>) -> DateTime<Utc> {
    local.with_timezone(&Utc)
}

/// Numeric coercion mirroring `fitparser`'s `TryInto<f64>` but infallible for
/// the numeric variants we encounter (everything non-numeric → `None`).
fn value_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Byte(x) | Value::UInt8(x) | Value::UInt8z(x) => Some(*x as f64),
        Value::Enum(x) => Some(*x as f64),
        Value::SInt8(x) => Some(*x as f64),
        Value::SInt16(x) => Some(*x as f64),
        Value::UInt16(x) | Value::UInt16z(x) => Some(*x as f64),
        Value::SInt32(x) => Some(*x as f64),
        Value::UInt32(x) | Value::UInt32z(x) => Some(*x as f64),
        Value::SInt64(x) => Some(*x as f64),
        Value::UInt64(x) | Value::UInt64z(x) => Some(*x as f64),
        Value::Float32(x) => Some(*x as f64),
        Value::Float64(x) => Some(*x),
        _ => None,
    }
}
