# MCP server (`/mcp`)

OpenFit embeds an [MCP](https://modelcontextprotocol.io) server directly in
`ofit-api` (PLAN.md Phase 8): LLM clients (Claude Code, MCP Inspector, …)
connect over **streamable HTTP** at `/mcp` and get 22 tools to query and drive
the platform — the same handlers the web UI uses, via in-process dispatch
(crate `ofit-mcp`, no logic duplication).

## Connecting

The endpoint shares the server's auth: a session token or the `OFIT_TOKEN`
bearer. For local dev, start the server with a token and connect:

```sh
OFIT_TOKEN=devtoken cargo run -p ofit-api
# repo .mcp.json already registers it for Claude Code: just
export OFIT_TOKEN=devtoken     # before launching claude
# or manually:
claude mcp add --transport http openfit http://localhost:8087/mcp \
  --header "Authorization: Bearer $OFIT_TOKEN"
```

Against the deployed LXC, point at its URL and its `OFIT_TOKEN` (from
`/etc/openfit/openfit.env`). Note: unlike `/api`, `/mcp` does **not** fall
open on a fresh install (`require_auth_strict`) — it always needs a session
token or `OFIT_TOKEN`, because it carries the SQL escape hatch.

Quick sanity check without an LLM:

```sh
npx -y @modelcontextprotocol/inspector --cli http://localhost:8087/mcp \
  --transport http --header "Authorization: Bearer $OFIT_TOKEN" --method tools/list
```

## Tools

| Family | Tools | Notes |
| --- | --- | --- |
| Orientation | `get_overview`, `db_schema` | counts + latest timestamps; table DDL |
| Catalog | `list_algorithms`, `list_variants`, `get_parameters` | the Phase-3 plugin/variant catalog |
| Query | `list_sources`, `list_activities`, `get_activity`, `query_wellness`, `get_derived`, `get_training_load`, `personal_records`, `get_gear`, `list_preferences`, `get_settings` | see payload shaping below |
| Safe mutations | `recompute`, `set_parameters`, `set_selection`, `set_setting`, `set_preference` | `recompute`/`set_parameters` are **synchronous** and can run minutes |
| Escape hatches | `query_sql`, `api_request` | see below |

### Payload shaping (LLM-sized responses)

Some REST endpoints are unbounded; the MCP layer post-processes:

* `list_activities` — the endpoint returns *all* activities; the tool filters
  (date/sport) and paginates MCP-side, newest first (default 100/page).
* `query_wellness` — the endpoint returns every raw sample in range
  (minute-level for years); the tool defaults to the **last 7 days** and
  stride-downsamples to `max_points` (default 500). `total_points` always
  reports the true in-window count.
* `get_activity` — the API already caps streams at 1000 chart points; the tool
  re-downsamples to `max_points` (default 300) and can filter to specific
  `metrics`. `sample_count` keeps the true resolution.

### Escape hatches

* `query_sql` — one read-only `SELECT`/`WITH`/`EXPLAIN` against the live DB.
  Layered guards: **engine-level read-only** (a detached connection with
  `PRAGMA query_only` / `default_transaction_read_only`), forbidden-keyword
  scan (conservative: matches inside string literals too), single statement
  only, **auth tables (`users`, `sessions`) denied** (credentials must never
  enter an LLM context), rows streamed + capped (default 200), 64 KB per-cell
  and 4 MB per-response budgets.
* `api_request` — generic GET/POST/PUT passthrough for endpoints without a
  dedicated tool. Blocked: DELETE (destructive), `/import*` (huge multipart),
  `/maintenance/*` (deletes data), `/auth/*`, wellness ingest (writes health
  data), `export.fit` (binary).

All tools carry MCP annotations (`readOnlyHint`, `destructiveHint`,
`idempotentHint`) so clients can auto-approve reads and confirm mutations.

## Architecture

```
MCP client ──HTTP(S), streamable──▶ /mcp (rmcp StreamableHttpService)
                                       │ require_auth (cookie / OFIT_TOKEN)
                                       ▼
                              ofit-mcp::OpenFitMcp
                               │ tower oneshot (in-process, pre-auth router clone)
                               ▼
                          /api handlers (same code as the web UI)
                               +  ofit_db::Db pool (query_sql / db_schema only)
```

Design decisions:

* **Thin layer over the API** (PLAN.md): tools dispatch synthetic requests
  into a clone of the protected router (state applied, auth `route_layer`
  stripped). Auth is enforced once at the `/mcp` ingress; adding a new REST
  endpoint makes it instantly reachable via `api_request` and ~10 lines away
  from a dedicated tool.
* **Host-header validation off** (rmcp's default allows only localhost): the
  server is reached via LAN IPs/proxies; the auth gate is the trust boundary.
* **Stateful sessions** (`Mcp-Session-Id`, in-memory) with 15 s SSE
  keep-alives. Behind a reverse proxy, disable response buffering and allow
  long read timeouts for the `GET /mcp` event stream. Multi-replica deploys
  would need sticky sessions (not a current deployment shape).
* CORS: the global layer also allows/exposes `mcp-session-id` (+
  `mcp-protocol-version`, `last-event-id`) so browser-based MCP clients work.
  Set `OFIT_CORS_ORIGINS` (comma-separated) to pin explicit browser origins
  instead of the default reflect-any-origin behavior.
* Deploy toolchain: rmcp is edition 2024 → workspace `rust-version` is 1.85;
  the Docker builder uses `rust:1.87` and the LXC update script now runs
  `rustup update stable` on existing containers. `Cargo.lock` is committed and
  deploy builds use `--locked`.

Phase 9 (generative visualizations) will add `viz_*` tools on this same
server — the tool families above deliberately leave that namespace open.
