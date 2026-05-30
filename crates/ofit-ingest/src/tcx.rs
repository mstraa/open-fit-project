//! TCX parser (Garmin Training Center XML), via `quick-xml`.
//!
//! We stream the document and pull each `<Trackpoint>` into samples:
//! LatLng, Altitude, Distance, HeartRate, Cadence, Speed. Sport comes from the
//! `<Activity Sport="...">` attribute. Cadence/Speed live in the Garmin
//! `ns3:TPX` extension (`RunCadence`/`Cadence`, `Speed`/`Watts`).

use chrono::{DateTime, Utc};
use ofit_core::StreamKind;
use quick_xml::events::Event;
use quick_xml::Reader;

use crate::{builder::RecordingBuilder, sport_from_str, Error};

/// Accumulator for the trackpoint currently being parsed.
#[derive(Default)]
struct Tp {
    time: Option<DateTime<Utc>>,
    lat: Option<f64>,
    lng: Option<f64>,
    alt: Option<f64>,
    dist: Option<f64>,
    hr: Option<f64>,
    cad: Option<f64>,
    speed: Option<f64>,
    watts: Option<f64>,
}

pub(crate) fn parse(name: &str, bytes: &[u8]) -> crate::Result<RecordingBuilder> {
    let mut b = RecordingBuilder::new(name);
    b.meta("parser", "quick-xml (tcx)");

    parse_inner(&mut b, bytes).map_err(|e| Error::Parse {
        format: "tcx",
        name: name.to_string(),
        reason: e.to_string(),
    })?;

    Ok(b)
}

fn parse_inner(b: &mut RecordingBuilder, bytes: &[u8]) -> Result<(), quick_xml::Error> {
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().trim_text(true);

    let mut buf = Vec::new();
    let mut in_tp = false;
    let mut tp = Tp::default();
    // The text-bearing leaf we are currently inside.
    let mut leaf: Option<Leaf> = None;
    // Inside a <Position> block (disambiguates Latitude/LongitudeDegrees).
    let mut creator: Option<String> = None;
    let mut in_creator = false;

    loop {
        match reader.read_event_into(&mut buf)? {
            Event::Start(e) => {
                let local = local_name(e.name().as_ref());
                match local.as_str() {
                    "Activity" => {
                        // Sport attribute on the Activity element.
                        if let Some(sport) = attr(&e, "Sport") {
                            b.set_sport(sport_from_str(&sport));
                        }
                    }
                    "Creator" => in_creator = true,
                    "Trackpoint" => {
                        in_tp = true;
                        tp = Tp::default();
                    }
                    "Time" if in_tp => leaf = Some(Leaf::Time),
                    "LatitudeDegrees" if in_tp => leaf = Some(Leaf::Lat),
                    "LongitudeDegrees" if in_tp => leaf = Some(Leaf::Lng),
                    "AltitudeMeters" if in_tp => leaf = Some(Leaf::Alt),
                    "DistanceMeters" if in_tp => leaf = Some(Leaf::Dist),
                    // HeartRateBpm/<Value> and TPX/<RunCadence|Cadence|Speed|Watts>.
                    "Value" if in_tp => leaf = Some(Leaf::HrValue),
                    "RunCadence" | "Cadence" if in_tp => leaf = Some(Leaf::Cad),
                    "Speed" if in_tp => leaf = Some(Leaf::Speed),
                    "Watts" if in_tp => leaf = Some(Leaf::Watts),
                    "Name" if in_creator => leaf = Some(Leaf::CreatorName),
                    _ => {}
                }
            }
            Event::Text(t) => {
                let Some(active) = leaf else {
                    buf.clear();
                    continue;
                };
                let txt = t.decode().map(|c| c.into_owned()).unwrap_or_default();
                let txt = txt.trim();
                match active {
                    Leaf::Time => {
                        tp.time = DateTime::parse_from_rfc3339(txt)
                            .ok()
                            .map(|d| d.with_timezone(&Utc));
                    }
                    Leaf::CreatorName => {
                        if creator.is_none() {
                            creator = Some(txt.to_string());
                        }
                    }
                    other => {
                        if let Ok(v) = txt.parse::<f64>() {
                            match other {
                                Leaf::Lat => tp.lat = Some(v),
                                Leaf::Lng => tp.lng = Some(v),
                                Leaf::Alt => tp.alt = Some(v),
                                Leaf::Dist => tp.dist = Some(v),
                                Leaf::HrValue => tp.hr = Some(v),
                                Leaf::Cad => tp.cad = Some(v),
                                Leaf::Speed => tp.speed = Some(v),
                                Leaf::Watts => tp.watts = Some(v),
                                _ => {}
                            }
                        }
                    }
                }
            }
            Event::End(e) => {
                let local = local_name(e.name().as_ref());
                match local.as_str() {
                    "Creator" => in_creator = false,
                    "Trackpoint" => {
                        in_tp = false;
                        flush(b, &tp);
                    }
                    "Time" | "LatitudeDegrees" | "LongitudeDegrees" | "AltitudeMeters"
                    | "DistanceMeters" | "Value" | "RunCadence" | "Cadence" | "Speed"
                    | "Watts" | "Name" => leaf = None,
                    _ => {}
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    if let Some(c) = creator {
        if let Some(m) = crate::manufacturer_from_device(&c) {
            b.meta("manufacturer", m);
        }
        b.meta("device", c);
    }
    Ok(())
}

/// Text-bearing leaves we care about inside a `<Trackpoint>`.
#[derive(Clone, Copy)]
enum Leaf {
    Time,
    Lat,
    Lng,
    Alt,
    Dist,
    HrValue,
    Cad,
    Speed,
    Watts,
    CreatorName,
}

/// Emit the finished trackpoint's samples (requires a timestamp).
fn flush(b: &mut RecordingBuilder, tp: &Tp) {
    let Some(ts) = tp.time else {
        return;
    };
    if let (Some(lat), Some(lng)) = (tp.lat, tp.lng) {
        b.push_latlng(ts, lat, lng);
    }
    if let Some(v) = tp.alt {
        b.push_scalar(StreamKind::Altitude, ts, v);
    }
    if let Some(v) = tp.dist {
        b.push_scalar(StreamKind::Distance, ts, v);
    }
    if let Some(v) = tp.hr {
        b.push_scalar(StreamKind::HeartRate, ts, v);
    }
    if let Some(v) = tp.cad {
        b.push_scalar(StreamKind::Cadence, ts, v);
    }
    if let Some(v) = tp.speed {
        b.push_scalar(StreamKind::Speed, ts, v);
    }
    if let Some(v) = tp.watts {
        b.push_scalar(StreamKind::Power, ts, v);
    }
}

fn attr(e: &quick_xml::events::BytesStart, name: &str) -> Option<String> {
    e.attributes().flatten().find_map(|a| {
        if local_name(a.key.as_ref()) == name {
            Some(String::from_utf8_lossy(&a.value).into_owned())
        } else {
            None
        }
    })
}

/// Strip an XML namespace prefix (`ns3:Speed` → `Speed`).
fn local_name(qname: &[u8]) -> String {
    let s = String::from_utf8_lossy(qname);
    match s.rsplit_once(':') {
        Some((_, local)) => local.to_string(),
        None => s.to_string(),
    }
}
