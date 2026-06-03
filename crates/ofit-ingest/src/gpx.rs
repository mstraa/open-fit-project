//! GPX parser.
//!
//! The standard track spine (lat/lng, elevation, time, track `type`) is read
//! with the `gpx` crate. The Garmin `TrackPointExtension` (gpxtpx: `hr`, `cad`,
//! `atemp`) is **not** surfaced by that crate, so we make a second lightweight
//! pass with `quick-xml`, aligning extension values to trackpoints by index
//! (both walks visit `<trkpt>` in document order).

use chrono::{DateTime, Utc};
use ofit_core::{Sport, StreamKind};
use quick_xml::events::Event;
use quick_xml::Reader;

use crate::{builder::RecordingBuilder, sport_from_str, wrap_parse_error, xml_local_name};

/// gpxtpx extension values for one trackpoint (index-aligned to the spine).
#[derive(Default, Clone, Copy)]
struct Ext {
    hr: Option<f64>,
    cad: Option<f64>,
    atemp: Option<f64>,
}

pub(crate) fn parse(name: &str, bytes: &[u8]) -> crate::Result<RecordingBuilder> {
    let gpx = gpx::read(bytes).map_err(|e| wrap_parse_error("gpx", name, e))?;

    let exts = parse_extensions(bytes)
        .map_err(|e| wrap_parse_error("gpx", name, format!("extension scan: {e}")))?;

    let mut b = RecordingBuilder::new(name);
    b.meta("parser", "gpx + quick-xml (gpxtpx extensions)");
    if let Some(creator) = gpx.creator.clone() {
        if let Some(m) = crate::manufacturer_from_device(&creator) {
            b.meta("manufacturer", m);
        }
        b.meta("device", creator);
    }

    // Sport from the first track's <type>, if present. Some GPX exports (e.g.
    // the Zepp App export) omit the track `<type>` entirely; as a last resort we
    // infer the sport from filename keywords so the recording can still cluster
    // with its sibling FIT/TCX of the same effort (which DO declare the sport).
    let sport = gpx
        .tracks
        .iter()
        .find_map(|t| t.type_.as_deref())
        .map(sport_from_str)
        .filter(|s| *s != Sport::Other)
        .unwrap_or_else(|| crate::sport_from_filename(name));
    b.set_sport(sport);

    let mut idx = 0usize;
    for track in &gpx.tracks {
        for seg in &track.segments {
            for wpt in &seg.points {
                // gpx exposes time as an opaque `Time`; format → RFC3339 → UTC.
                let ts = match waypoint_time(wpt) {
                    Some(ts) => ts,
                    None => {
                        idx += 1;
                        continue;
                    }
                };
                let point = wpt.point();
                b.push_latlng(ts, point.y(), point.x());
                if let Some(ele) = wpt.elevation {
                    b.push_scalar(StreamKind::Altitude, ts, ele);
                }
                if let Some(spd) = wpt.speed {
                    b.push_scalar(StreamKind::Speed, ts, spd);
                }
                if let Some(ext) = exts.get(idx) {
                    if let Some(hr) = ext.hr {
                        b.push_scalar(StreamKind::HeartRate, ts, hr);
                    }
                    if let Some(cad) = ext.cad {
                        b.push_scalar(StreamKind::Cadence, ts, cad);
                    }
                    if let Some(t) = ext.atemp {
                        b.push_scalar(StreamKind::Temperature, ts, t);
                    }
                }
                idx += 1;
            }
        }
    }

    Ok(b)
}

/// Convert the `gpx` crate's `Time` to a UTC timestamp via its RFC3339 form.
fn waypoint_time(wpt: &gpx::Waypoint) -> Option<DateTime<Utc>> {
    let t = wpt.time?;
    let s = t.format().ok()?;
    crate::parse_rfc3339(&s)
}

/// Second pass: collect gpxtpx extension values per `<trkpt>` in document order.
fn parse_extensions(bytes: &[u8]) -> Result<Vec<Ext>, quick_xml::Error> {
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().trim_text(true);

    let mut out: Vec<Ext> = Vec::new();
    let mut cur = Ext::default();
    let mut in_trkpt = false;
    // Tracks the gpxtpx leaf we're inside, if any.
    let mut leaf: Option<&'static str> = None;
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(e) => {
                let local = xml_local_name(e.name().as_ref());
                match local.as_str() {
                    "trkpt" => {
                        in_trkpt = true;
                        cur = Ext::default();
                    }
                    "hr" if in_trkpt => leaf = Some("hr"),
                    "cad" if in_trkpt => leaf = Some("cad"),
                    "atemp" if in_trkpt => leaf = Some("atemp"),
                    _ => {}
                }
            }
            Event::Text(t) if leaf.is_some() && in_trkpt => {
                let txt = t.decode().map(|c| c.into_owned()).unwrap_or_default();
                if let Ok(v) = txt.trim().parse::<f64>() {
                    match leaf {
                        Some("hr") => cur.hr = Some(v),
                        Some("cad") => cur.cad = Some(v),
                        Some("atemp") => cur.atemp = Some(v),
                        _ => {}
                    }
                }
            }
            Event::End(e) => {
                let local = xml_local_name(e.name().as_ref());
                match local.as_str() {
                    "trkpt" => {
                        in_trkpt = false;
                        out.push(cur);
                    }
                    "hr" | "cad" | "atemp" => leaf = None,
                    _ => {}
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    Ok(out)
}
