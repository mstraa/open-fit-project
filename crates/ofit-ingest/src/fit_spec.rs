//! Shared FIT profile constants — the single source of truth for the spec
//! knowledge that both the decoder ([`crate::fit`]) and the encoder
//! ([`crate::fit_export`]) must agree on.
//!
//! ## FIT profile assumptions (pinned)
//! - Protocol version 2.0, profile version 21.40 (the version our encoder
//!   stamps into the file header; the decoder is version-tolerant via
//!   `fitparser`). These constants are stable across the profile and shared
//!   here so decode/encode can never drift on the geo/time scaling.
//! - `position_lat`/`position_long` are FIT *semicircles*: a signed 32-bit
//!   angle where a full ±180° sweep maps onto the full ±2^31 range. So
//!   `degrees = semicircles * 180 / 2^31` and the inverse for encoding.
//! - `date_time` fields are seconds since the FIT epoch
//!   (1989-12-31 00:00:00 UTC), 631_065_600 s after the Unix epoch.
//!
//! Only constants that are a genuine single source of truth for the profile
//! live here. The base-type ids, message/field numbers, and invalid sentinels
//! are encoder-only (the decoder resolves fields by name via `fitparser`) and
//! deliberately stay in [`crate::fit_export`].

/// Semicircles per full ±180° sweep: a FIT angle is a signed 32-bit value over
/// the ±2^31 range. Both the semicircle→degree and degree→semicircle factors
/// are derived from this so decode and encode share one definition.
const SEMICIRCLE_FULL_SCALE: f64 = 2_147_483_648.0; // 2^31

/// FIT semicircles → degrees: `deg = semicircles * 180 / 2^31`.
pub(crate) const SEMICIRCLES_TO_DEGREES: f64 = 180.0 / SEMICIRCLE_FULL_SCALE;

/// degrees → FIT semicircles: `semicircles = degrees * 2^31 / 180`.
pub(crate) const DEGREES_TO_SEMICIRCLES: f64 = SEMICIRCLE_FULL_SCALE / 180.0;

/// Seconds between the Unix epoch (1970-01-01) and the FIT epoch
/// (1989-12-31 00:00:00 UTC). FIT `date_time` is seconds since the FIT epoch.
pub(crate) const FIT_EPOCH_OFFSET: i64 = 631_065_600;
