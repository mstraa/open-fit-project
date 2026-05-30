# Open Fit — web

React + Vite + TypeScript dashboard for [Open Fit](../README.md). **API-first**
(every UI is a typed client of `ofit-api`) and **themable** via design tokens.

> Phase 0 scaffold: app name, theme toggle, and a live `GET /health` check that
> proves the frontend ↔ backend wiring. Real features (activity list/detail,
> uPlot charts, MapLibre maps, per-metric source picker) land in Phase 1.

## Stack

- **Vite** + **React 18** + **TypeScript** (strict).
- **Theming via design tokens** — CSS custom properties in
  [`src/theme/tokens.css`](src/theme/tokens.css); light/dark via
  `[data-theme]`, switched by a tiny `ThemeProvider` + `ThemeToggle`.
- **API client** — generated from the backend OpenAPI schema (not hand-written).
  See [`src/api/README.md`](src/api/README.md).

## Develop

```sh
npm install        # install deps
npm run dev        # start Vite dev server (http://localhost:5173)
npm run build      # type-check + production build to dist/
npm run preview    # preview the production build
npm run gen:api    # (placeholder) generate the typed client from OpenAPI
```

Run the backend alongside it:

```sh
cargo run -p ofit-api   # from the repo root (serves :8080)
```

The dev server proxies `/health`, `/api`, and `/api-docs` to `http://localhost:8080`.

## Configuration

| Env var         | Default                 | Purpose                       |
| --------------- | ----------------------- | ----------------------------- |
| `VITE_API_BASE` | `http://localhost:8080` | Base URL of the ofit-api host |

Copy [`.env.example`](.env.example) to `.env` to override.

## Theming

All colors, spacing, and typography are CSS variables (`--color-*`, `--space-*`,
`--font-*`). To re-skin, change tokens — components reference variables only, so
no component code changes are needed. Dark mode is `[data-theme="dark"]` on
`<html>`, set by the `ThemeProvider` (persisted to `localStorage`, falls back to
the OS `prefers-color-scheme`).

## Layout

```
web/
  index.html
  package.json  vite.config.ts  tsconfig.json
  .env.example
  src/
    main.tsx            # entry — mounts ThemeProvider + App
    App.tsx             # app name, theme toggle, GET /health badge
    vite-env.d.ts       # typed import.meta.env
    api/
      client.ts         # minimal fetch wrapper (temporary)
      README.md         # how the typed client is generated from OpenAPI
    theme/
      tokens.css        # design tokens (light + dark)
      ThemeProvider.tsx # theme state + [data-theme] application
      ThemeToggle.tsx   # light/dark toggle button
```

## License

AGPL-3.0-or-later (see repo [LICENSE](../LICENSE)).
