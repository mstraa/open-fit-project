// Resolve a CSS color expression to a concrete rgb() string usable by canvas
// (uPlot) and WebGL (MapLibre), neither of which can resolve `var(--x)` nor
// parse modern `oklch(...)` color syntax. We first expand a leading var(),
// then normalize via a probe element whose computed `color` the browser returns
// as rgb()/rgba().

export function resolveCssColor(input: string, fallback = "#888888"): string {
  if (typeof window === "undefined" || !input) return fallback;
  try {
    let value = input.trim();
    const varMatch = value.match(/^var\(\s*(--[\w-]+)/);
    if (varMatch) {
      value =
        getComputedStyle(document.documentElement)
          .getPropertyValue(varMatch[1])
          .trim() || fallback;
    }
    if (!value) return fallback;
    const probe = document.createElement("span");
    probe.style.color = value;
    probe.style.display = "none";
    document.body.appendChild(probe);
    const rgb = getComputedStyle(probe).color;
    probe.remove();
    return rgb || fallback;
  } catch {
    return fallback;
  }
}
