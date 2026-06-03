//! Minimal FIT **encoder** — the counterpart to [`crate::fit`]'s parser.
//!
//! Produces a standards-compliant `.fit` activity file from a resolved set of
//! per-second record points, so a user can export an Open Fit activity back out
//! to Garmin Connect / Strava / any FIT tool. We hand-roll the binary format
//! (the `fitparser` crate is read-only) — it is small and well-specified:
//!
//! * a 14-byte file **header** (incl. its own CRC) carrying the data size;
//! * a stream of **messages**, each preceded by a 1-byte record header; a
//!   *definition* message declares a local message type's fields, and the
//!   *data* messages that follow encode values in that exact field order;
//!   integers are little-endian (architecture byte = 0);
//! * a trailing 2-byte **CRC** over the whole file.
//!
//! We emit `file_id`, the `record` firehose, and a single `session` + `activity`
//! summary — enough for Garmin/Strava to ingest and for our own parser to
//! round-trip (verified in the tests). Absent values are written as the FIT
//! "invalid" sentinel for their base type. Field scales/offsets follow the FIT
//! profile so importers read real units.

use chrono::{DateTime, Utc};
use ofit_core::Sport;

use crate::fit_spec::{DEGREES_TO_SEMICIRCLES, FIT_EPOCH_OFFSET};

// ---- FIT base type ids (high bit set = multi-byte, endian-aware) ----
const T_ENUM: u8 = 0x00;
const T_SINT8: u8 = 0x01;
const T_UINT8: u8 = 0x02;
const T_UINT16: u8 = 0x84;
const T_SINT32: u8 = 0x85;
const T_UINT32: u8 = 0x86;

// ---- invalid sentinels per base type ----
const INVALID_U8: u8 = 0xFF;
const INVALID_U16: u16 = 0xFFFF;
const INVALID_U32: u32 = 0xFFFF_FFFF;
const INVALID_S8: i8 = 0x7F;
const INVALID_S32: i32 = 0x7FFF_FFFF;

/// One record point to encode (already aligned to a single timestamp, one
/// second of activity). Every metric is optional — missing ones are written as
/// the FIT invalid sentinel so the fixed record definition stays uniform.
#[derive(Debug, Clone)]
pub struct FitRecordPoint {
    /// Wall-clock time of this record (UTC).
    pub timestamp: DateTime<Utc>,
    /// Latitude in degrees.
    pub lat: Option<f64>,
    /// Longitude in degrees.
    pub lng: Option<f64>,
    /// Altitude in metres.
    pub altitude_m: Option<f64>,
    /// Heart rate in bpm.
    pub heart_rate: Option<u8>,
    /// Cadence in rpm/spm.
    pub cadence: Option<u8>,
    /// Cumulative distance in metres.
    pub distance_m: Option<f64>,
    /// Instantaneous speed in m/s.
    pub speed_mps: Option<f64>,
    /// Power in watts.
    pub power_w: Option<u16>,
    /// Temperature in °C.
    pub temperature_c: Option<f64>,
}

impl FitRecordPoint {
    /// A bare point carrying only a timestamp; fill the metric fields you have.
    pub fn at(timestamp: DateTime<Utc>) -> Self {
        Self {
            timestamp,
            lat: None,
            lng: None,
            altitude_m: None,
            heart_rate: None,
            cadence: None,
            distance_m: None,
            speed_mps: None,
            power_w: None,
            temperature_c: None,
        }
    }
}

fn fit_timestamp(t: DateTime<Utc>) -> u32 {
    (t.timestamp() - FIT_EPOCH_OFFSET).clamp(0, u32::MAX as i64) as u32
}

/// FIT `sport` enum for the file's session/sport.
fn sport_code(s: Sport) -> u8 {
    match s {
        Sport::Running => 1,
        Sport::Cycling => 2,
        Sport::Swimming => 5,
        Sport::Strength => 10, // "training"
        Sport::Walking => 11,
        Sport::Other => 0, // generic
    }
}

/// FIT `sub_sport` enum (only strength has a meaningful one here).
fn sub_sport_code(s: Sport) -> u8 {
    match s {
        Sport::Strength => 20, // strength_training
        _ => 0,                // generic
    }
}

/// A growable FIT body builder. Accumulates definition + data messages; the
/// caller wraps the finished body in a header + trailing CRC via [`Self::finish`].
struct FitWriter {
    body: Vec<u8>,
}

impl FitWriter {
    fn new() -> Self {
        Self { body: Vec::new() }
    }

    /// Emit a definition message for `local_type` declaring `global_msg`'s fields
    /// as `(field_def_num, size_bytes, base_type)` triples, in encode order.
    fn definition(&mut self, local_type: u8, global_msg: u16, fields: &[(u8, u8, u8)]) {
        self.body.push(0x40 | (local_type & 0x0F)); // definition record header
        self.body.push(0x00); // reserved
        self.body.push(0x00); // architecture: 0 = little-endian
        self.body.extend_from_slice(&global_msg.to_le_bytes());
        self.body.push(fields.len() as u8);
        for &(num, size, base) in fields {
            self.body.push(num);
            self.body.push(size);
            self.body.push(base);
        }
    }

    /// Start a data message for `local_type`. Append field values (in the same
    /// order as the matching definition) via the `push_*` helpers.
    fn data_header(&mut self, local_type: u8) {
        self.body.push(local_type & 0x0F); // normal data record header
    }

    fn push_u8(&mut self, v: u8) {
        self.body.push(v);
    }
    fn push_i8(&mut self, v: i8) {
        self.body.push(v as u8);
    }
    fn push_u16(&mut self, v: u16) {
        self.body.extend_from_slice(&v.to_le_bytes());
    }
    fn push_u32(&mut self, v: u32) {
        self.body.extend_from_slice(&v.to_le_bytes());
    }
    fn push_i32(&mut self, v: i32) {
        self.body.extend_from_slice(&v.to_le_bytes());
    }

    /// Wrap the accumulated body in a 14-byte header (with header CRC) and a
    /// trailing file CRC, returning the complete `.fit` bytes.
    fn finish(self) -> Vec<u8> {
        let body = self.body;
        let mut header = Vec::with_capacity(14);
        header.push(14); // header size
        header.push(0x20); // protocol version 2.0
        header.extend_from_slice(&2140u16.to_le_bytes()); // profile version 21.40
        header.extend_from_slice(&(body.len() as u32).to_le_bytes()); // data size
        header.extend_from_slice(b".FIT");
        let header_crc = crc16(&header); // CRC over the first 12 header bytes
        header.extend_from_slice(&header_crc.to_le_bytes());

        let mut out = header;
        out.extend_from_slice(&body);
        let file_crc = crc16(&out); // CRC over header + body
        out.extend_from_slice(&file_crc.to_le_bytes());
        out
    }
}

/// The standard FIT 16-entry CRC table / algorithm (nibble-wise).
fn crc16(data: &[u8]) -> u16 {
    const TABLE: [u16; 16] = [
        0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401, 0xA001, 0x6C00, 0x7800,
        0xB401, 0x5000, 0x9C01, 0x8801, 0x4400,
    ];
    let mut crc: u16 = 0;
    for &byte in data {
        // lower nibble
        let mut tmp = TABLE[(crc & 0x0F) as usize];
        crc = (crc >> 4) & 0x0FFF;
        crc = crc ^ tmp ^ TABLE[(byte & 0x0F) as usize];
        // upper nibble
        tmp = TABLE[(crc & 0x0F) as usize];
        crc = (crc >> 4) & 0x0FFF;
        crc = crc ^ tmp ^ TABLE[((byte >> 4) & 0x0F) as usize];
    }
    crc
}

// ---- local message type ids (one definition each) ----
const L_FILE_ID: u8 = 0;
const L_RECORD: u8 = 1;
const L_LAP: u8 = 2;
const L_SESSION: u8 = 3;
const L_ACTIVITY: u8 = 4;

/// Encode an activity to a `.fit` byte vector.
///
/// `started_at` seeds the file/session start when there are no points (e.g. a
/// summary-only activity); otherwise the first/last record timestamps drive the
/// session window. `points` should be time-ordered, one per second.
pub fn encode_activity_fit(
    sport: Sport,
    started_at: DateTime<Utc>,
    points: &[FitRecordPoint],
) -> Vec<u8> {
    let mut w = FitWriter::new();

    let start_ts = points.first().map(|p| p.timestamp).unwrap_or(started_at);
    let end_ts = points.last().map(|p| p.timestamp).unwrap_or(started_at);

    // ---- file_id (global 0): mark this as an `activity` file ----
    w.definition(
        L_FILE_ID,
        0,
        &[
            (0, 1, T_ENUM),   // type
            (1, 2, T_UINT16), // manufacturer
            (2, 2, T_UINT16), // product
            (4, 4, T_UINT32), // time_created (date_time)
        ],
    );
    w.data_header(L_FILE_ID);
    w.push_u8(4); // file type 4 = activity
    w.push_u16(255); // manufacturer 255 = development
    w.push_u16(0); // product
    w.push_u32(fit_timestamp(start_ts)); // time_created

    // ---- record (global 20): the per-second firehose ----
    w.definition(
        L_RECORD,
        20,
        &[
            (253, 4, T_UINT32), // timestamp
            (0, 4, T_SINT32),   // position_lat (semicircles)
            (1, 4, T_SINT32),   // position_long (semicircles)
            (5, 4, T_UINT32),   // distance (scale 100 → cm)
            (2, 2, T_UINT16),   // altitude (scale 5, offset 500)
            (6, 2, T_UINT16),   // speed (scale 1000 → mm/s)
            (7, 2, T_UINT16),   // power (W)
            (3, 1, T_UINT8),    // heart_rate (bpm)
            (4, 1, T_UINT8),    // cadence (rpm)
            (13, 1, T_SINT8),   // temperature (°C)
        ],
    );
    let mut last_distance_m: Option<f64> = None;
    for p in points {
        if let Some(d) = p.distance_m {
            last_distance_m = Some(d);
        }
        w.data_header(L_RECORD);
        w.push_u32(fit_timestamp(p.timestamp));
        w.push_i32(p.lat.map(deg_to_semicircles).unwrap_or(INVALID_S32));
        w.push_i32(p.lng.map(deg_to_semicircles).unwrap_or(INVALID_S32));
        w.push_u32(
            p.distance_m
                .map(|d| (d * 100.0).round().clamp(0.0, (INVALID_U32 - 1) as f64) as u32)
                .unwrap_or(INVALID_U32),
        );
        w.push_u16(
            p.altitude_m
                .map(|a| ((a + 500.0) * 5.0).round().clamp(0.0, (INVALID_U16 - 1) as f64) as u16)
                .unwrap_or(INVALID_U16),
        );
        w.push_u16(
            p.speed_mps
                .map(|s| (s * 1000.0).round().clamp(0.0, (INVALID_U16 - 1) as f64) as u16)
                .unwrap_or(INVALID_U16),
        );
        w.push_u16(p.power_w.unwrap_or(INVALID_U16));
        w.push_u8(p.heart_rate.unwrap_or(INVALID_U8));
        w.push_u8(p.cadence.unwrap_or(INVALID_U8));
        w.push_i8(
            p.temperature_c
                .map(|t| t.round().clamp(-127.0, 126.0) as i8)
                .unwrap_or(INVALID_S8),
        );
    }

    let elapsed_ms = ((end_ts - start_ts).num_milliseconds().max(0)) as u32;
    let total_distance = last_distance_m
        .map(|d| (d * 100.0).round().clamp(0.0, (INVALID_U32 - 1) as f64) as u32)
        .unwrap_or(INVALID_U32);

    // ---- lap (global 19): one lap spanning the whole effort, so the session's
    // `num_laps = 1` / `first_lap_index = 0` below actually points at a real lap
    // (Garmin Connect expects the lap a session advertises to exist). ----
    w.definition(
        L_LAP,
        19,
        &[
            (254, 2, T_UINT16), // message_index
            (253, 4, T_UINT32), // timestamp (lap end)
            (2, 4, T_UINT32),   // start_time
            (7, 4, T_UINT32),   // total_elapsed_time (scale 1000)
            (8, 4, T_UINT32),   // total_timer_time (scale 1000)
            (9, 4, T_UINT32),   // total_distance (scale 100)
            (0, 1, T_ENUM),     // event
            (1, 1, T_ENUM),     // event_type
        ],
    );
    w.data_header(L_LAP);
    w.push_u16(0); // message_index — matches session.first_lap_index
    w.push_u32(fit_timestamp(end_ts)); // timestamp
    w.push_u32(fit_timestamp(start_ts)); // start_time
    w.push_u32(elapsed_ms); // total_elapsed_time
    w.push_u32(elapsed_ms); // total_timer_time
    w.push_u32(total_distance); // total_distance
    w.push_u8(9); // event = lap
    w.push_u8(1); // event_type = stop

    // ---- session (global 18): one session summarising the whole effort ----
    w.definition(
        L_SESSION,
        18,
        &[
            (254, 2, T_UINT16), // message_index
            (253, 4, T_UINT32), // timestamp (session end)
            (2, 4, T_UINT32),   // start_time
            (7, 4, T_UINT32),   // total_elapsed_time (scale 1000)
            (8, 4, T_UINT32),   // total_timer_time (scale 1000)
            (9, 4, T_UINT32),   // total_distance (scale 100)
            (25, 2, T_UINT16),  // first_lap_index
            (26, 2, T_UINT16),  // num_laps
            (5, 1, T_ENUM),     // sport
            (6, 1, T_ENUM),     // sub_sport
            (0, 1, T_ENUM),     // event
            (1, 1, T_ENUM),     // event_type
        ],
    );
    w.data_header(L_SESSION);
    w.push_u16(0); // message_index
    w.push_u32(fit_timestamp(end_ts)); // timestamp
    w.push_u32(fit_timestamp(start_ts)); // start_time
    w.push_u32(elapsed_ms); // total_elapsed_time
    w.push_u32(elapsed_ms); // total_timer_time
    w.push_u32(total_distance); // total_distance
    w.push_u16(0); // first_lap_index
    w.push_u16(1); // num_laps
    w.push_u8(sport_code(sport));
    w.push_u8(sub_sport_code(sport));
    w.push_u8(8); // event = session
    w.push_u8(1); // event_type = stop

    // ---- activity (global 34): wraps the single session ----
    w.definition(
        L_ACTIVITY,
        34,
        &[
            (253, 4, T_UINT32), // timestamp
            (0, 4, T_UINT32),   // total_timer_time (scale 1000)
            (1, 2, T_UINT16),   // num_sessions
            (2, 1, T_ENUM),     // type
            (3, 1, T_ENUM),     // event
            (4, 1, T_ENUM),     // event_type
        ],
    );
    w.data_header(L_ACTIVITY);
    w.push_u32(fit_timestamp(end_ts)); // timestamp
    w.push_u32(elapsed_ms); // total_timer_time
    w.push_u16(1); // num_sessions
    w.push_u8(0); // type = manual
    w.push_u8(26); // event = activity
    w.push_u8(1); // event_type = stop

    w.finish()
}

fn deg_to_semicircles(deg: f64) -> i32 {
    let v = (deg * DEGREES_TO_SEMICIRCLES).round();
    if v >= i32::MAX as f64 {
        i32::MAX
    } else if v <= i32::MIN as f64 {
        i32::MIN
    } else {
        v as i32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn ts(sec: i64) -> DateTime<Utc> {
        Utc.timestamp_opt(1_700_000_000 + sec, 0).unwrap()
    }

    /// A simple run with HR + power + GPS round-trips through our own parser.
    #[test]
    fn round_trips_through_parser() {
        let mut points = Vec::new();
        for i in 0..10i64 {
            let mut p = FitRecordPoint::at(ts(i));
            p.heart_rate = Some(140 + i as u8);
            p.power_w = Some(250 + i as u16);
            p.cadence = Some(180);
            p.speed_mps = Some(3.5);
            p.distance_m = Some(i as f64 * 3.5);
            p.altitude_m = Some(100.0 + i as f64);
            p.lat = Some(48.85 + i as f64 * 0.0001);
            p.lng = Some(2.35 + i as f64 * 0.0001);
            p.temperature_c = Some(21.0);
            points.push(p);
        }
        let bytes = encode_activity_fit(Sport::Running, ts(0), &points);

        // The header advertises the body size, and the whole thing CRCs clean.
        let records = fitparser::from_bytes(&bytes).expect("our encoder must parse");

        // file_id present and marked as an activity.
        let has_activity_file = records.iter().any(|r| {
            format!("{:?}", r.kind()) == "FileId"
                && r.fields()
                    .iter()
                    .any(|f| f.name() == "type" && format!("{:?}", f.value()).contains("activity"))
        });
        assert!(has_activity_file, "file_id should declare type=activity");

        // Exactly the 10 record messages we wrote, HR decoded faithfully.
        let recs: Vec<_> = records
            .iter()
            .filter(|r| format!("{:?}", r.kind()) == "Record")
            .collect();
        assert_eq!(recs.len(), 10, "should round-trip 10 records");
        let first_hr = recs[0]
            .fields()
            .iter()
            .find(|f| f.name() == "heart_rate")
            .map(|f| f.value().to_string());
        assert_eq!(first_hr.as_deref(), Some("140"), "first HR should be 140 bpm");

        // The sport survives in the session message (our parser reads it there).
        let sport = records.iter().find_map(|r| {
            (format!("{:?}", r.kind()) == "Session")
                .then(|| {
                    r.fields()
                        .iter()
                        .find(|f| f.name() == "sport")
                        .map(|f| f.value().to_string())
                })
                .flatten()
        });
        assert_eq!(sport.as_deref(), Some("running"));

        // Exactly one lap (the session advertises num_laps = 1).
        let laps = records.iter().filter(|r| format!("{:?}", r.kind()) == "Lap").count();
        assert_eq!(laps, 1, "should emit one whole-effort lap");
    }

    /// An empty (summary-only) activity still produces a parseable file.
    #[test]
    fn empty_activity_is_valid() {
        let bytes = encode_activity_fit(Sport::Cycling, ts(0), &[]);
        let records = fitparser::from_bytes(&bytes).expect("empty activity must still parse");
        assert!(records.iter().any(|r| format!("{:?}", r.kind()) == "FileId"));
        assert!(records.iter().any(|r| format!("{:?}", r.kind()) == "Activity"));
    }
}
