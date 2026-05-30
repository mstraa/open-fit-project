# syntax=docker/dockerfile:1
#
# Open Fit — ofit-api image (AGPL-3.0-or-later)
#
# Multi-stage build:
#   1. builder — compiles the `ofit-api` binary in release mode.
#   2. runtime — slim Debian image with just the binary + CA certs.
#
# The same image powers both deployment tiers (see docker/README.md):
#   - simple: DATABASE_URL defaults to a SQLite file under the /data volume.
#   - full:   DATABASE_URL is overridden to point at Postgres/Timescale.

# ---------- builder ----------
FROM rust:1.83-bookworm AS builder
WORKDIR /build

# Copy the whole workspace so path-dependencies resolve. The release profile
# (lto = "thin") lives in the root Cargo.toml.
COPY . .

# Build only the API binary; the rest of the workspace is brought in as needed.
RUN --mount=type=cache,target=/build/target \
    --mount=type=cache,target=/usr/local/cargo/registry \
    cargo build --release -p ofit-api && \
    cp target/release/ofit-api /usr/local/bin/ofit-api

# ---------- runtime ----------
FROM debian:bookworm-slim AS runtime

# ofit-api talks to SQLite or Postgres; ca-certificates is handy for TLS to
# external Postgres. libssl/sqlite are pulled in dynamically by sqlx as needed.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

# Run as an unprivileged user; it must own /data for the SQLite tier.
RUN useradd --system --create-home --uid 10001 ofit && \
    mkdir -p /data && chown ofit:ofit /data

COPY --from=builder /usr/local/bin/ofit-api /usr/local/bin/ofit-api

USER ofit
WORKDIR /data

# Persistent state: SQLite DB (simple tier), imports, config/wizard output.
VOLUME ["/data"]

# REST + WebSocket/SSE.
EXPOSE 8080

# Sensible defaults; override either in compose or `docker run -e`.
#  - DATABASE_URL: SQLite file on the /data volume by default (simple tier).
#  - OFIT_TOKEN:   single-user auth token; empty means "set me via the wizard".
ENV DATABASE_URL="sqlite:///data/ofit.db?mode=rwc" \
    OFIT_TOKEN="" \
    OFIT_BIND="0.0.0.0:8080" \
    RUST_LOG="info"

# Container-level liveness check; compose files also define their own.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:8080/health || exit 1

ENTRYPOINT ["/usr/local/bin/ofit-api"]
