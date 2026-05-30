# Deployment — two tiers

Open Fit ships in **two self-hosted tiers**. Both run the *same* `ofit-api`
binary (built once by the root [`Dockerfile`](../Dockerfile)); the only
difference is the database `ofit-api` connects to. This works because
`ofit-db` uses [sqlx](https://github.com/launchbadge/sqlx) and supports
**SQLite and Postgres from day one** — no application code changes between
tiers (PLAN.md verification step 7).

| Tier | Database | Use it for |
|------|----------|------------|
| **simple** | SQLite file on a named volume | Single container, easiest start. First-run wizard. |
| **full** | TimescaleDB (Postgres 16) | High-volume continuous wellness / HR time-series. |

Everything is **100% cloudless** (AGPL-3.0-or-later) — nothing here phones home.

## Configuration

Both compose files auto-load a `.env` sitting next to them.

```sh
cp docker/.env.example docker/.env
# edit docker/.env: set OFIT_TOKEN, and POSTGRES_PASSWORD for the full tier
```

Key variables (see [`.env.example`](.env.example) for the full list):

| Variable | Meaning |
|----------|---------|
| `DATABASE_URL` | SQLite URL for the simple tier (`sqlite:///data/ofit.db?mode=rwc`). |
| `POSTGRES_DATABASE_URL` | Postgres URL the api uses in the full tier (`postgres://…@db:5432/ofit`). |
| `OFIT_TOKEN` | Single-user auth token. Leave empty to set it in the first-run wizard. |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Credentials for the `db` service (full tier). |

The API listens on **8080** (REST + WebSocket/SSE) with a `/health` endpoint
used by both the image `HEALTHCHECK` and the compose healthchecks. Persistent
state (SQLite DB, imports, wizard config) lives on the `/data` volume.

## Simple tier (SQLite)

PLAN.md verification step 1 — starts in a single container; wizard runs on
first launch.

```sh
docker compose -f docker/docker-compose.simple.yml up
```

Then open the wizard / API at <http://localhost:8080>. The SQLite database is
stored on the `ofit-data` named volume, so it survives container restarts.

## Full tier (Postgres / TimescaleDB)

PLAN.md verification step 7 — same scenarios, no application code change.

```sh
cp docker/.env.example docker/.env   # set POSTGRES_PASSWORD + OFIT_TOKEN first
docker compose -f docker/docker-compose.full.yml up
```

The `api` service waits for `db` to become healthy (`depends_on` +
`pg_isready` healthcheck) before starting, and points `DATABASE_URL` at the
`db` service over the compose network. Postgres data persists on the
`ofit-pgdata` named volume.

## Common operations

```sh
# Run detached
docker compose -f docker/docker-compose.simple.yml up -d

# Tail logs
docker compose -f docker/docker-compose.simple.yml logs -f api

# Rebuild the image after Rust changes
docker compose -f docker/docker-compose.full.yml build api

# Stop (keep volumes / data)
docker compose -f docker/docker-compose.simple.yml down

# Stop and wipe data (drops named volumes)
docker compose -f docker/docker-compose.full.yml down -v
```

## Notes

- The build context for both compose files is the **repo root** (`..`) so the
  Dockerfile can see the whole Cargo workspace.
- The image runs as an unprivileged `ofit` user that owns `/data`.
- `curl` is included in the runtime image purely for the healthcheck.
