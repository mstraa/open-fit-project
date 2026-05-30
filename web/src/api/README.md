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

## What's here now (Phase 0 → Phase 1)

- **`client.ts`** — the thin transport (`apiFetch`, `apiSend`, `apiPostForm`,
  `getHealth`, `API_BASE`). This layer is keeper material; only the *types* are
  temporary.
- **`types.ts`** — **all** API-boundary types, hand-written for Phase 1 and
  **centralized here on purpose** so they're trivially swapped for the
  OpenAPI-generated client later (see the `TODO(api-first)` at the top). They
  mirror the canonical `ofit-core` types (serde `snake_case` enums).
- **`endpoints.ts`** — typed wrappers (`listActivities`, `getActivity`,
  `listSources`, `listPreferences`, `putPreference`, `importFiles`). These are
  deliberately **tolerant** of field-name drift because the Phase-1 REST contract
  is still indicative: a few likely aliases are normalized at the boundary so the
  UI sees one stable shape. Replace with the generated client once the OpenAPI
  schema exists; keep the transport wrapper.

## Conventions

- Base URL comes from `import.meta.env.VITE_API_BASE` (default `http://localhost:8080`).
- Generated files in `src/api/generated/` are build artifacts — do not edit by hand.
