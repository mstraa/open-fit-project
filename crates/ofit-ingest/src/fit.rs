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
    let mut ident = DeviceIdentity::default();

    for rec in &records {
        match format!("{:?}", rec.kind()).as_str() {
            "Record" => extract_record(&mut b, rec),
            "Sport" | "Session" if !sport_set => {
                if let Some(s) = field_str(rec, "sport") {
                    b.set_sport(sport_from_str(&s));
                    sport_set = true;
                }
            }
            // file_id is the authoritative origin of the recording.
            "FileId" => ident.absorb_file_id(rec),
            // The "creator" device_info row (device_index="creator") is the
            // recording device; later rows are attached sensors (HRM, footpod…).
            "DeviceInfo" => ident.absorb_device_info(rec),
            _ => {}
        }
    }

    let (device, manufacturer) = ident.resolve(name);
    b.meta("device", device);
    if let Some(m) = manufacturer {
        b.meta("manufacturer", m);
    }

    Ok(b)
}

/// Accumulates identity signals from `file_id` + the creator `device_info` row
/// to derive a human device name and a manufacturer string.
#[derive(Default)]
struct DeviceIdentity {
    manufacturer: Option<String>,
    garmin_product: Option<String>,
    product_name: Option<String>,
    /// Free-form `source` on the creator device_info (e.g. Zepp/Huami host).
    source: Option<String>,
}

impl DeviceIdentity {
    fn absorb_file_id(&mut self, rec: &FitDataRecord) {
        self.manufacturer
            .get_or_insert_with(|| field_str(rec, "manufacturer").unwrap_or_default());
        if let Some(p) = nonempty(field_str(rec, "garmin_product")) {
            self.garmin_product.get_or_insert(p);
        }
        if let Some(p) = nonempty(field_str(rec, "product_name")) {
            self.product_name.get_or_insert(p);
        }
    }

    fn absorb_device_info(&mut self, rec: &FitDataRecord) {
        // Only the creator row describes the recording device itself.
        if field_str(rec, "device_index").as_deref() != Some("creator") {
            return;
        }
        if let Some(m) = nonempty(field_str(rec, "manufacturer")) {
            // Prefer a concrete manufacturer over a placeholder like
            // "development".
            if self
                .manufacturer
                .as_deref()
                .map(is_placeholder_manufacturer)
                .unwrap_or(true)
            {
                self.manufacturer = Some(m);
            }
        }
        if let Some(p) = nonempty(field_str(rec, "garmin_product")) {
            self.garmin_product.get_or_insert(p);
        }
        if let Some(p) = nonempty(field_str(rec, "product_name")) {
            self.product_name.get_or_insert(p);
        }
        if let Some(s) = nonempty(field_str(rec, "source")) {
            self.source.get_or_insert(s);
        }
    }

    /// Resolve `(device_name, manufacturer)` from the gathered signals, falling
    /// back to the filename only as a last resort.
    fn resolve(&self, filename: &str) -> (String, Option<String>) {
        let raw_mfr = self.manufacturer.as_deref().unwrap_or("");

        // Zepp/Amazfit (Huami) FITs declare manufacturer "development" but carry
        // a `source` host like "run.mifit.huami.com" on the creator row.
        if let Some(src) = &self.source {
            let s = src.to_ascii_lowercase();
            if s.contains("huami") || s.contains("mifit") || s.contains("zepp") || s.contains("amazfit")
            {
                return ("Zepp".to_string(), Some("Zepp / Amazfit (Huami)".to_string()));
            }
        }

        let mfr_name = manufacturer_name(raw_mfr);

        // Garmin: map the product id to a model name where we can.
        if raw_mfr.eq_ignore_ascii_case("garmin") {
            if let Some(prod) = &self.garmin_product {
                if let Some(model) = garmin_product_name(prod) {
                    return (model.to_string(), Some("Garmin".to_string()));
                }
                // Unknown product id but known vendor.
                return (format!("Garmin ({prod})"), Some("Garmin".to_string()));
            }
            return ("Garmin".to_string(), Some("Garmin".to_string()));
        }

        // Stryd-origin file (rare: a Stryd app export rather than a Garmin one).
        if raw_mfr.eq_ignore_ascii_case("stryd") {
            return ("Stryd".to_string(), Some("Stryd".to_string()));
        }

        // A concrete, non-placeholder manufacturer with a product name.
        if !is_placeholder_manufacturer(raw_mfr) && !raw_mfr.is_empty() {
            let name = self
                .product_name
                .clone()
                .filter(|p| !p.is_empty())
                .unwrap_or_else(|| mfr_name.to_string());
            return (name, Some(mfr_name.to_string()));
        }

        // Last resort: derive from the filename keywords.
        device_from_filename(filename)
    }
}

/// Whether a manufacturer string is a placeholder we should look past.
fn is_placeholder_manufacturer(m: &str) -> bool {
    matches!(m.to_ascii_lowercase().as_str(), "development" | "dynastream" | "" )
}

fn nonempty(s: Option<String>) -> Option<String> {
    s.filter(|s| !s.trim().is_empty())
}

/// Map a FIT manufacturer string (as decoded by `fitparser`) to a display name.
fn manufacturer_name(raw: &str) -> &'static str {
    match raw.to_ascii_lowercase().as_str() {
        "garmin" => "Garmin",
        "stryd" => "Stryd",
        "wahoo_fitness" | "wahoo" => "Wahoo",
        "polar" | "polar_electro" => "Polar",
        "coros" => "Coros",
        "suunto" => "Suunto",
        "huami" | "zepp" | "amazfit" => "Zepp / Amazfit (Huami)",
        "" | "development" => "Unknown",
        // Title-case the unknown vendor token for a friendlier label.
        other => leaked_titlecase(other),
    }
}

/// Title-case an unknown lowercase vendor token into a `'static` string.
fn leaked_titlecase(s: &str) -> &'static str {
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i == 0 {
            out.extend(c.to_uppercase());
        } else {
            out.push(c);
        }
    }
    Box::leak(out.into_boxed_str())
}

/// Map a Garmin product token (as decoded by `fitparser`, e.g. `"fr945"`) to a
/// human model name. Covers common Forerunner/Fenix/Edge ids; unknowns return
/// `None` so the caller keeps the raw token.
fn garmin_product_name(prod: &str) -> Option<&'static str> {
    Some(match prod.to_ascii_lowercase().as_str() {
        "fr945" => "Garmin Forerunner 945",
        "fr945_lte" => "Garmin Forerunner 945 LTE",
        "fr955" => "Garmin Forerunner 955",
        "fr965" => "Garmin Forerunner 965",
        "fr745" => "Garmin Forerunner 745",
        "fr935" => "Garmin Forerunner 935",
        "fr920xt" => "Garmin Forerunner 920XT",
        "fr245" | "fr245m" => "Garmin Forerunner 245",
        "fr255" => "Garmin Forerunner 255",
        "fr265" => "Garmin Forerunner 265",
        "fenix5" => "Garmin Fenix 5",
        "fenix5x" => "Garmin Fenix 5X",
        "fenix6" => "Garmin Fenix 6",
        "fenix6_pro" => "Garmin Fenix 6 Pro",
        "fenix7" => "Garmin Fenix 7",
        "edge_530" => "Garmin Edge 530",
        "edge_830" => "Garmin Edge 830",
        "edge_1030" => "Garmin Edge 1030",
        "vivoactive4" => "Garmin Vivoactive 4",
        _ => return None,
    })
}

/// Last-resort device naming from filename keywords.
fn device_from_filename(filename: &str) -> (String, Option<String>) {
    let f = filename.to_ascii_lowercase();
    if f.contains("stryd") {
        // A Stryd-labelled export of a Garmin recording is still a Garmin file;
        // but with no in-file identity we surface the keyword we have.
        ("Stryd".to_string(), Some("Stryd".to_string()))
    } else if f.contains("zepp") || f.contains("amazfit") || f.contains("huami") {
        ("Zepp".to_string(), Some("Zepp / Amazfit (Huami)".to_string()))
    } else if f.contains("garmin") || f.contains("forerunner") || f.contains("fr945") {
        ("Garmin Forerunner 945".to_string(), Some("Garmin".to_string()))
    } else {
        ("File import (fit)".to_string(), None)
    }
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

    // --- Running dynamics (Stryd developer fields + native Garmin profile) ---
    // Field names and units per the discovery dump: Stryd emits human-readable
    // developer-field names ("Vertical Oscillation" in cm, "Ground Time" in ms,
    // "Form Power"/"Air Power" in W, "Leg Spring Stiffness" in kN/m); native
    // Garmin running-dynamics fields use the FIT profile names/scaling.

    // Vertical oscillation → canonical mm. Native `vertical_oscillation` is
    // already mm; Stryd's "Vertical Oscillation" is cm → ×10.
    if let Some(v) = field_f64(rec, "vertical_oscillation") {
        b.push_scalar(StreamKind::VerticalOscillation, ts, v);
    } else if let Some(cm) = field_f64(rec, "Vertical Oscillation") {
        b.push_scalar(StreamKind::VerticalOscillation, ts, cm * 10.0);
    }

    // Ground contact time (ms). Native `stance_time` and Stryd "Ground Time"
    // are both already milliseconds.
    push(
        b,
        rec,
        ts,
        StreamKind::GroundContactTime,
        &["stance_time", "Ground Time"],
    );

    // Stride / step length → canonical mm. Native `step_length` is mm; the FIT
    // `cycle_length16` profile field is metres → ×1000.
    if let Some(v) = field_f64(rec, "step_length") {
        b.push_scalar(StreamKind::StrideLength, ts, v);
    } else if let Some(m) = field_f64(rec, "cycle_length16") {
        b.push_scalar(StreamKind::StrideLength, ts, m * 1000.0);
    }

    // Vertical ratio (%) — native Garmin running dynamics (absent from Stryd's
    // export, present on Garmin native running dynamics).
    push(b, rec, ts, StreamKind::VerticalRatio, &["vertical_ratio"]);

    // Stryd power decomposition + leg spring stiffness.
    push(b, rec, ts, StreamKind::FormPower, &["Form Power"]);
    push(b, rec, ts, StreamKind::AirPower, &["Air Power"]);
    push(
        b,
        rec,
        ts,
        StreamKind::LegSpringStiffness,
        &["Leg Spring Stiffness"],
    );
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
