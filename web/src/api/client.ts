// Minimal hand-written fetch wrapper.
//
// Thin transport. API-boundary TYPES come from the OpenAPI-generated schema
// (`npm run gen:api` → ./generated/schema.d.ts, aliased in ./schema.ts) so they
// can't drift from the server. See ./README.md.

import type { HealthDto } from "./schema";

const STORAGE_BASE = "ofit_api_base";
const STORAGE_TOKEN = "ofit_token";

function stored(key: string): string {
  try {
    return (typeof localStorage !== "undefined" && localStorage.getItem(key)) || "";
  } catch {
    return "";
  }
}

/**
 * Base URL of the ofit-api backend, in priority order:
 *  1. a runtime-configured base (localStorage `ofit_api_base`) — the **mobile app**
 *     sets this to your LAN server (e.g. http://192.168.1.29:8087);
 *  2. build-time `VITE_API_BASE`;
 *  3. **relative** (same-origin) — the default for web (dev proxy / prod served by
 *     ofit-api), so cookies + the live WS work without CORS.
 */
export const API_BASE: string = stored(STORAGE_BASE) || (import.meta.env.VITE_API_BASE ?? "");

/** Persist the API base (mobile "connect to your server"). Caller reloads. */
export function setApiBase(url: string): void {
  try {
    localStorage.setItem(STORAGE_BASE, url.trim().replace(/\/+$/, ""));
  } catch {
    /* ignore */
  }
}

/** Bearer session token for non-cookie clients (the cross-origin mobile app). */
export function getToken(): string {
  return stored(STORAGE_TOKEN);
}
export function setToken(token: string): void {
  try {
    localStorage.setItem(STORAGE_TOKEN, token);
  } catch {
    /* ignore */
  }
}
export function clearToken(): void {
  try {
    localStorage.removeItem(STORAGE_TOKEN);
  } catch {
    /* ignore */
  }
}

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
  const token = getToken();
  // Pull `headers` out of init so the spread below can't clobber the merged
  // headers (the Bearer token) — that bug made every POST/PUT 401 on mobile.
  const { headers: initHeaders, ...restInit } = init ?? {};
  const res = await fetch(url, {
    // Cookie auth for same-origin web; Bearer token for the cross-origin mobile app.
    credentials: "include",
    ...restInit,
    headers: {
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(initHeaders ?? {}),
    },
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

/** Shape of GET /health — from the OpenAPI-generated schema. */
export type HealthResponse = HealthDto;

/** Proves API-first wiring: pings the backend health endpoint. */
export function getHealth(): Promise<HealthResponse> {
  return apiFetch<HealthResponse>("/health");
}
