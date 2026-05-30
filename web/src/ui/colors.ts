// Resolve a CSS color expression to a concrete `rgb()/rgba()` string usable by
// canvas (uPlot) and especially WebGL (MapLibre), neither of which can resolve
// `var(--x)`, and MapLibre's color parser can't read modern `oklch(...)` either.
//
// We expand a leading var(), then paint the color onto a 1×1 canvas and read the
// rendered pixel back. That yields plain 8-bit rgb regardless of the input color
// space (oklch, color(), hsl, …) — the one normalization both targets accept.
// (getComputedStyle().color is NOT reliable: recent Chrome preserves the authored
// color space, so an oklch token comes back as oklch.)

function expandVar(input: string): string {
  const m = input.trim().match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/);
  if (!m) return input.trim();
  const resolved = getComputedStyle(document.documentElement)
    .getPropertyValue(m[1])
    .trim();
  return resolved || (m[2] ?? "").trim();
}

export function resolveCssColor(input: string, fallback = "#888888"): string {
  if (typeof document === "undefined" || !input) return fallback;
  try {
    const value = expandVar(input) || fallback;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d");
    if (!ctx) return value;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = value; // parses oklch()/hsl()/hex/named; no-op if invalid
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
  } catch {
    return fallback;
  }
}
