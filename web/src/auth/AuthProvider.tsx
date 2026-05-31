// Auth gate + context. On load it decides between the first-run setup wizard,
// the login screen, or the app. Exposes the current username + a logout action
// to the shell. Talks to /api/auth/* (server-side sessions via http-only cookie).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  apiFetch,
  apiSend,
  ApiError,
  API_BASE,
  setApiBase,
  setToken,
  clearToken,
} from "../api/client";
import { LogoMark } from "../app/icons";

/** Running inside the Capacitor native shell (the Android app)? */
function isNative(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean((window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.())
  );
}

interface AuthValue {
  username: string;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

/** Current account + logout, available to any in-app component. */
export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}

type Gate =
  | { kind: "loading" }
  | { kind: "connect" }
  | { kind: "setup" }
  | { kind: "login" }
  | { kind: "authed"; username: string };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [gate, setGate] = useState<Gate>({ kind: "loading" });

  const resolve = useCallback(async () => {
    // Short timeout so an unreachable LAN server fails fast to the connect screen
    // instead of hanging the boot on "Loading…".
    const fast = { timeoutMs: 6000 };
    try {
      const status = await apiFetch<{ needs_setup: boolean }>("/api/auth/status", undefined, fast);
      if (status.needs_setup) {
        setGate({ kind: "setup" });
        return;
      }
      try {
        const me = await apiFetch<{ username: string }>("/api/auth/me", undefined, fast);
        setGate({ kind: "authed", username: me.username });
      } catch (e) {
        // 401 → need to log in; a timeout/network error → offline (connect screen).
        if (e instanceof ApiError && e.status === 401) setGate({ kind: "login" });
        else throw e;
      }
    } catch {
      // API unreachable. On the mobile app (or once a server URL is configured)
      // prompt to (re)connect to the self-hosted server; on web with the default
      // relative base, let the app render and show its own offline state.
      if (isNative() || API_BASE) {
        setGate({ kind: "connect" });
      } else {
        setGate({ kind: "authed", username: "" });
      }
    }
  }, []);

  useEffect(() => {
    void resolve();
  }, [resolve]);

  const logout = useCallback(async () => {
    try {
      await apiSend("/api/auth/logout", "POST");
    } catch {
      /* ignore */
    }
    clearToken();
    setGate({ kind: "login" });
  }, []);

  if (gate.kind === "loading") {
    return <AuthShell>Loading…</AuthShell>;
  }
  if (gate.kind === "connect") {
    return <ConnectForm onOffline={() => setGate({ kind: "authed", username: "" })} onRetry={resolve} />;
  }
  if (gate.kind === "setup" || gate.kind === "login") {
    return <AuthForm mode={gate.kind} onDone={resolve} />;
  }
  return (
    <AuthContext.Provider value={{ username: gate.username, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

/* ------------------------------------------------------------- auth screens */

function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "var(--bg)",
        color: "var(--fg)",
        padding: "var(--space-4)",
      }}
    >
      {children}
    </div>
  );
}

function AuthForm({ mode, onDone }: { mode: "setup" | "login"; onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const path = mode === "setup" ? "/api/auth/setup" : "/api/auth/login";
      const res = await apiSend<{ username: string; token?: string }>(path, "POST", {
        username,
        password,
      });
      // Store the session token so the cross-origin mobile app can use Bearer auth
      // (web also stores it harmlessly; it primarily relies on the cookie).
      if (res?.token) setToken(res.token);
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setError("Invalid username or password.");
      else if (err instanceof ApiError && err.status === 400)
        setError("Username required and password must be at least 8 characters.");
      else setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  };

  const isSetup = mode === "setup";
  return (
    <AuthShell>
      <form
        onSubmit={submit}
        className="card"
        style={{ width: "min(380px, 92vw)", display: "flex", flexDirection: "column", gap: "var(--space-4)" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            className="rail__logo"
            style={{ width: 34, height: 34, display: "grid", placeItems: "center" }}
          >
            <LogoMark />
          </span>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>
              Open<span style={{ color: "var(--accent)" }}>Fit</span>
            </div>
            <div className="faint" style={{ fontSize: 10.5, letterSpacing: "0.12em", textTransform: "uppercase" }}>
              self-hosted · cloudless
            </div>
          </div>
        </div>

        <div>
          <h1 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>
            {isSetup ? "Create your account" : "Sign in"}
          </h1>
          <p className="muted" style={{ fontSize: 12.5, margin: "4px 0 0" }}>
            {isSetup
              ? "First run — choose the single account for this server."
              : "Enter your credentials to continue."}
          </p>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12 }}>
          <span className="muted">Username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
            style={inputStyle}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12 }}>
          <span className="muted">Password{isSetup ? " (≥ 8 characters)" : ""}</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={isSetup ? "new-password" : "current-password"}
            required
            style={inputStyle}
          />
        </label>

        {error && (
          <div className="pill pill--bad" style={{ justifyContent: "flex-start" }}>
            {error}
          </div>
        )}

        <button type="submit" className="btn" disabled={busy} style={{ justifyContent: "center" }}>
          {busy ? "…" : isSetup ? "Create account" : "Sign in"}
        </button>
      </form>
    </AuthShell>
  );
}

/** Mobile/offline: point the app at your self-hosted ofit-api on the LAN, retry,
 *  or continue offline (live HR + on-device buffering keep working away from home;
 *  history fills in once you're back on your network). */
function ConnectForm({ onOffline, onRetry }: { onOffline: () => void; onRetry: () => void }) {
  const [url, setUrl] = useState(API_BASE || "http://192.168.1.29:8087");
  const [retrying, setRetrying] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setApiBase(url);
    // The base is read at module load, so reload to apply it, then re-resolve.
    window.location.reload();
  };
  const retry = async () => {
    setRetrying(true);
    await onRetry();
    setRetrying(false);
  };
  return (
    <AuthShell>
      <form
        onSubmit={submit}
        className="card"
        style={{ width: "min(380px, 92vw)", display: "flex", flexDirection: "column", gap: "var(--space-4)" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="rail__logo" style={{ width: 34, height: 34, display: "grid", placeItems: "center" }}>
            <LogoMark />
          </span>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>
              Open<span style={{ color: "var(--accent)" }}>Fit</span>
            </div>
            <div className="faint" style={{ fontSize: 10.5, letterSpacing: "0.12em", textTransform: "uppercase" }}>
              self-hosted · cloudless
            </div>
          </div>
        </div>
        <div>
          <h1 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>Server unreachable</h1>
          <p className="muted" style={{ fontSize: 12.5, margin: "4px 0 0" }}>
            Can&apos;t reach your Open Fit server. Check the address, retry, or continue
            offline — live data keeps recording and syncs when you&apos;re back on your network.
          </p>
        </div>
        <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12 }}>
          <span className="muted">Server URL</span>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            placeholder="http://192.168.1.29:8087"
            required
            style={inputStyle}
          />
        </label>
        <button type="submit" className="btn" style={{ justifyContent: "center" }}>
          Connect
        </button>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="btn btn--ghost"
            style={{ flex: 1, justifyContent: "center" }}
            onClick={() => void retry()}
            disabled={retrying}
          >
            {retrying ? "Retrying…" : "Retry"}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            style={{ flex: 1, justifyContent: "center" }}
            onClick={onOffline}
          >
            Continue offline
          </button>
        </div>
      </form>
    </AuthShell>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--surface-2)",
  border: "1px solid var(--border)",
  borderRadius: "var(--r-sm)",
  color: "var(--fg)",
  padding: "9px 11px",
  font: "inherit",
  fontSize: 13.5,
};
