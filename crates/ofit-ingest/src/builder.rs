//! Shared accumulator used by the per-format parsers.
//!
//! Each parser pushes absolute-timestamped points; the builder then derives the
//! `started_at`/`ended_at` window from the first/last timestamp and converts
//! every point into a [`Sample`] whose `t_offset_ms` is milliseconds since
//! `started_at`.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use ofit_core::{ContentHash, RawRecording, Sample, Sport, Stream, StreamKind};
use uuid::Uuid;

use crate::{offset_ms, Error, Format, ParsedRecording, PLACEHOLDER_SOURCE_ID};

/// One timestamped value awaiting offset resolution.
enum Point {
    Scalar { ts: DateTime<Utc>, value: f64 },
    LatLng { ts: DateTime<Utc>, lat: f64, lng: f64 },
}

impl Point {
    fn ts(&self) -> DateTime<Utc> {
        match self {
            Point::Scalar { ts, .. } => *ts,
            Point::LatLng { ts, .. } => *ts,
        }
    }
}

/// Accumulates per-kind timestamped points plus recording metadata, then bakes
/// a [`ParsedRecording`].
///
/// Stream kinds keep insertion order so output is stable across runs.
pub struct RecordingBuilder {
    name: String,
    sport: Sport,
    content_hash: ContentHash,
    metadata: serde_json::Map<String, serde_json::Value>,
    // Preserve first-seen order of kinds for deterministic stream ordering.
    order: Vec<StreamKind>,
    points: BTreeMap<u8, Vec<Point>>,
}

/// Stable ordinal for a [`StreamKind`] so it can key the `BTreeMap` while we
/// still emit streams in first-seen order.
fn kind_key(kind: StreamKind) -> u8 {
    match kind {
        StreamKind::HeartRate => 0,
        StreamKind::Power => 1,
        StreamKind::Cadence => 2,
        StreamKind::Speed => 3,
        StreamKind::Altitude => 4,
        StreamKind::LatLng => 5,
        StreamKind::Wind => 6,
        StreamKind::Temperature => 7,
        StreamKind::Distance => 8,
    }
}

impl RecordingBuilder {
    /// Start a builder for `name`. The content hash starts as a placeholder and
    /// is overwritten with the real SHA-256 by the crate entry point.
    pub fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
            sport: Sport::Other,
            content_hash: ContentHash(String::new()),
            metadata: serde_json::Map::new(),
            order: Vec::new(),
            points: BTreeMap::new(),
        }
    }

    /// Set the detected sport.
    pub fn set_sport(&mut self, sport: Sport) {
        self.sport = sport;
    }

    /// Overwrite the content hash (real SHA-256).
    pub(crate) fn set_content_hash(&mut self, hash: ContentHash) {
        self.content_hash = hash;
    }

    /// Attach an arbitrary metadata key.
    pub fn meta(&mut self, key: &str, value: impl Into<serde_json::Value>) {
        self.metadata.insert(key.to_string(), value.into());
    }

    fn track(&mut self, kind: StreamKind) {
        if !self.order.contains(&kind) {
            self.order.push(kind);
        }
    }

    /// Push a scalar sample for `kind` at absolute timestamp `ts`.
    pub fn push_scalar(&mut self, kind: StreamKind, ts: DateTime<Utc>, value: f64) {
        self.track(kind);
        self.points
            .entry(kind_key(kind))
            .or_default()
            .push(Point::Scalar { ts, value });
    }

    /// Push a geographic sample at absolute timestamp `ts` (degrees).
    pub fn push_latlng(&mut self, ts: DateTime<Utc>, lat: f64, lng: f64) {
        self.track(StreamKind::LatLng);
        self.points
            .entry(kind_key(StreamKind::LatLng))
            .or_default()
            .push(Point::LatLng { ts, lat, lng });
    }

    /// Earliest timestamp seen across all points, if any.
    fn min_ts(&self) -> Option<DateTime<Utc>> {
        self.points
            .values()
            .flat_map(|v| v.iter().map(Point::ts))
            .min()
    }

    /// Latest timestamp seen across all points, if any.
    fn max_ts(&self) -> Option<DateTime<Utc>> {
        self.points
            .values()
            .flat_map(|v| v.iter().map(Point::ts))
            .max()
    }

    /// Finalize into a [`ParsedRecording`], deriving the time window from the
    /// first/last sample timestamp.
    pub(crate) fn into_parsed(mut self, format: Format) -> crate::Result<ParsedRecording> {
        let started_at = self.min_ts().ok_or_else(|| Error::Empty {
            format: format.label(),
            name: self.name.clone(),
        })?;
        let ended_at = self.max_ts().unwrap_or(started_at);

        self.metadata
            .insert("filename".into(), self.name.clone().into());
        self.metadata
            .insert("format".into(), format.label().into());

        let recording_id = Uuid::new_v4();
        let recording = RawRecording {
            id: recording_id,
            source_id: PLACEHOLDER_SOURCE_ID,
            content_hash: self.content_hash.clone(),
            sport: self.sport,
            started_at,
            ended_at,
            metadata: serde_json::Value::Object(self.metadata.clone()),
            ingested_at: Utc::now(),
        };

        // Emit streams in first-seen kind order; drop empty channels.
        let mut streams = Vec::new();
        for kind in &self.order {
            let Some(points) = self.points.get(&kind_key(*kind)) else {
                continue;
            };
            if points.is_empty() {
                continue;
            }
            let mut stream = Stream::new(recording_id, *kind);
            stream.samples = points
                .iter()
                .map(|p| match p {
                    Point::Scalar { ts, value } => Sample::Scalar {
                        t_offset_ms: offset_ms(started_at, *ts),
                        value: *value,
                    },
                    Point::LatLng { ts, lat, lng } => Sample::LatLng {
                        t_offset_ms: offset_ms(started_at, *ts),
                        lat: *lat,
                        lng: *lng,
                    },
                })
                .collect();
            streams.push(stream);
        }

        Ok(ParsedRecording { recording, streams })
    }
}
