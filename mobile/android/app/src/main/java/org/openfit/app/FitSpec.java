package org.openfit.app;

/**
 * Shared FIT profile constants — the Java mirror of
 * {@code crates/ofit-ingest/src/fit_spec.rs}, which is the single source of truth
 * the server's Rust FIT decoder/encoder agree on. Kept in lockstep here so the
 * on-device workout encoder ({@link FitEncoder}) can never drift from the server's
 * codec on the geo/time scaling. If you change a value here, change it there too.
 *
 * Pinned FIT profile: {@code position_lat}/{@code position_long} are signed-32-bit
 * <em>semicircles</em> over the ±2^31 range (deg = semicircles·180/2^31); a
 * {@code date_time} is seconds since the FIT epoch (1989-12-31T00:00:00Z, which is
 * 631_065_600 s after the Unix epoch).
 */
public final class FitSpec {
    private FitSpec() {}

    /** Semicircles per full ±180° sweep (2^31). */
    public static final double SEMICIRCLE_FULL_SCALE = 2147483648.0; // 2^31
    /** degrees → FIT semicircles (encode). */
    public static final double DEGREES_TO_SEMICIRCLES = SEMICIRCLE_FULL_SCALE / 180.0;
    /** FIT semicircles → degrees (decode). */
    public static final double SEMICIRCLES_TO_DEGREES = 180.0 / SEMICIRCLE_FULL_SCALE;
    /** Seconds between the Unix epoch and the FIT epoch (1989-12-31T00:00:00Z). */
    public static final long FIT_EPOCH_OFFSET = 631065600L;
}
