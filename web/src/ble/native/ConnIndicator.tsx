// Small connection indicator for the topbar: a grey dot when nothing is
// connected, a green dot + count when ≥1 native device is streaming. Reads the
// app-global NativeBleProvider. Renders nothing off-device (desktop web).

import { Link } from "react-router-dom";
import { useNativeBle } from "./NativeBleProvider";

export function ConnIndicator() {
  const { available, connectedCount, status } = useNativeBle();
  if (!available) return null;
  const on = connectedCount > 0;
  const reconnecting = status === "reconnecting" || status === "connecting";

  return (
    <Link
      to="/devices"
      className="pill"
      title={on ? `${connectedCount} device${connectedCount > 1 ? "s" : ""} connected` : "No devices connected"}
      style={{ gap: 7, textDecoration: "none" }}
      aria-label={on ? `${connectedCount} connected` : "no devices connected"}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: on ? "var(--good)" : reconnecting ? "var(--warn, #e0a83e)" : "var(--faint)",
          boxShadow: on ? "0 0 0 3px oklch(70% 0.13 150 / .2)" : undefined,
        }}
      />
      {on ? <span className="num" style={{ fontSize: 12 }}>{connectedCount}</span> : null}
    </Link>
  );
}
