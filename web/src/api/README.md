# API client

The web app is **API-first**: every UI is just a typed client of the `ofit-api`
backend. We do **not** hand-write API request/response types.

## How the typed client is produced

`ofit-api` (axum + utoipa) serves its OpenAPI schema at:

```
$VITE_API_BASE/api-docs/openapi.json   # default: http://localhost:8080/api-docs/openapi.json
```

The fully-typed client is **generated** from that schema (e.g. via
[`openapi-typescript`](https://github.com/openapi-ts/openapi-typescript) or
[`@hey-api/openapi-ts`](https://heyo.dev/)) into `src/api/generated/`.

Run it with:

```sh
npm run gen:api
```

(Currently a placeholder — see the `gen:api` script in `package.json`. It will be
implemented once `ofit-api` exposes the OpenAPI document.)

## What's here now (Phase 0)

- **`client.ts`** — a minimal hand-written `fetch` wrapper (`apiFetch`, `getHealth`,
  `API_BASE`). This is a temporary bootstrap so the app can prove end-to-end wiring
  by calling `GET /health`. Once `gen:api` is wired up, response types here should be
  replaced by the generated ones; the thin transport wrapper can remain.

## Conventions

- Base URL comes from `import.meta.env.VITE_API_BASE` (default `http://localhost:8080`).
- Generated files in `src/api/generated/` are build artifacts — do not edit by hand.
