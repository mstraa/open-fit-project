// Minimal hand-written fetch wrapper.
//
// This is a temporary stand-in. The real, fully-typed API client will be
// GENERATED from the ofit-api OpenAPI schema (utoipa) — see ./README.md.
// Do NOT hand-write request/response types here once generation is wired up.

/**
 * Base URL of the ofit-api backend.
 * Read from Vite env (`VITE_API_BASE`), defaulting to the local dev server.
 * During `npm run dev` an empty/relative base also works because vite.config.ts
 * proxies /health, /api and /api-docs to ofit-api.
 */
export const API_BASE: string =
  import.meta.env.VITE_API_BASE ?? "http://localhost:8087";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Issue a JSON request against the API and parse the response body. */
export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    throw new ApiError(`${res.status} ${res.statusText}`, res.status);
  }
  // Tolerate empty bodies (e.g. 204) by returning undefined-as-T.
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * POST a `FormData` body (used by the multipart import endpoint). We do NOT set
 * Content-Type so the browser adds the multipart boundary automatically.
 */
export async function apiPostForm<T>(
  path: string,
  form: FormData,
): Promise<T> {
  return apiFetch<T>(path, { method: "POST", body: form, headers: {} });
}

/** Send a request with an optional JSON body and the right Content-Type. */
export async function apiSend<T>(
  path: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<T> {
  if (body === undefined) {
    return apiFetch<T>(path, { method });
  }
  return apiFetch<T>(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Shape of GET /health. Will be replaced by the generated OpenAPI type. */
export interface HealthResponse {
  status: string;
  [key: string]: unknown;
}

/** Proves API-first wiring: pings the backend health endpoint. */
export function getHealth(): Promise<HealthResponse> {
  return apiFetch<HealthResponse>("/health");
}
