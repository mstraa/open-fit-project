// A theme-aware uPlot line chart for a single resolved scalar stream.
//
// uPlot draws to a <canvas>, so axis/grid colors don't inherit CSS. We read the
// current design tokens via getComputedStyle and rebuild the plot when the
// theme (or data) changes, keeping light/dark correct.
//
// - `syncKey` links cursors across charts (hovering one moves all).
// - `onHover(ms)` reports the hovered time so the map can place its locator dot.
// - a small tooltip shows the value at the cursor, on top of the cursor line.

import { memo, useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { useTheme } from "../theme/ThemeProvider";
import { resolveCssColor } from "../ui/colors";
import type { ScalarSample } from "../api/types";

function tokenColor(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export interface LineChartProps {
  samples: ScalarSample[];
  /** Line stroke color (CSS token or color). */
  stroke: string;
  unit: string;
  label: string;
  height?: number;
  /** Shared key to sync the cursor across sibling charts. */
  syncKey?: string;
  /** Reports the hovered time in ms since start (null on leave). */
  onHover?: (ms: number | null) => void;
  /**
   * Optional formatter for a y value in the tooltip/legend (e.g. pace m:ss).
   * Defaults to a 0-decimal number + unit.
   */
  valueFormat?: (v: number) => string;
  /** Optional formatter for the y-axis tick labels (defaults to integers). */
  yAxisFormat?: (v: number) => string;
  /** Invert the y-axis (used for pace so faster/lower sits higher). */
  invertY?: boolean;
}

function LineChartImpl({
  samples,
  stroke,
  unit,
  label,
  height = 200,
  syncKey,
  onHover,
  valueFormat,
  yAxisFormat,
  invertY = false,
}: LineChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;
  // `theme` is read so the effect re-runs and recolors on theme switch.
  const { theme } = useTheme();

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const xs = samples.map((s) => s.t_offset_ms / 1000);
    const ys = samples.map((s) => s.value);
    const data: uPlot.AlignedData = [xs, ys];

    const fmtVal = (v: number) => (valueFormat ? valueFormat(v) : `${v.toFixed(0)} ${unit}`);
    const fmtAxis = (v: number) => (yAxisFormat ? yAxisFormat(v) : String(Math.round(v)));

    const axisColor = resolveCssColor(tokenColor("--color-text-muted", "#888"), "#888");
    const gridColor = resolveCssColor(tokenColor("--color-border", "#ccc"), "#ccc");
    const strokeColor = resolveCssColor(stroke, axisColor);

    const width = el.clientWidth || 600;

    const axisStyle = {
      stroke: axisColor,
      grid: { stroke: gridColor, width: 1 },
      ticks: { stroke: gridColor, width: 1 },
      font: "12px var(--font-sans, sans-serif)",
    };

    // Tooltip showing the value at the cursor, on top of the cursor line.
    const tip = document.createElement("div");
    tip.style.cssText =
      "position:absolute;top:-15px;transform:translateX(-50%);display:none;" +
      "padding:1px 6px;border-radius:4px;white-space:nowrap;pointer-events:none;" +
      "font:600 11px var(--font-mono,monospace);z-index:10;" +
      "background:var(--surface-2);border:1px solid var(--border);";
    tip.style.color = strokeColor;

    const cursorPlugin: uPlot.Plugin = {
      hooks: {
        init: (u) => {
          // Let the value pill sit above the plot area instead of being clipped.
          u.over.style.overflow = "visible";
          u.over.appendChild(tip);
        },
        setCursor: (u) => {
          const idx = u.cursor.idx;
          if (idx == null) {
            tip.style.display = "none";
            onHoverRef.current?.(null);
            return;
          }
          const xv = u.data[0][idx];
          const yv = u.data[1][idx];
          if (yv == null || xv == null) {
            tip.style.display = "none";
          } else {
            tip.style.display = "block";
            tip.style.left = `${u.valToPos(xv, "x", false)}px`;
            tip.textContent = fmtVal(yv);
          }
          if (xv != null) onHoverRef.current?.(xv * 1000);
        },
      },
    };

    const opts: uPlot.Options = {
      width,
      height,
      cursor: {
        y: false,
        ...(syncKey ? { sync: { key: syncKey } } : {}),
      },
      legend: { show: false },
      scales: {
        x: { time: false },
        // Reserve headroom at the top so the value pill on the cursor line sits
        // above the trace instead of covering it. When inverted (pace), the
        // axis runs high→low so faster (lower pace) renders higher up.
        y: {
          dir: invertY ? -1 : 1,
          range: (_u, dataMin, dataMax) => {
            const pad = dataMax - dataMin || 1;
            return [dataMin - pad * 0.08, dataMax + pad * 0.16];
          },
        },
      },
      plugins: [cursorPlugin],
      axes: [
        {
          ...axisStyle,
          values: (_u, vals) =>
            vals.map((v) => {
              const m = Math.floor(v / 60);
              const s = Math.round(v % 60);
              return `${m}:${String(s).padStart(2, "0")}`;
            }),
        },
        {
          ...axisStyle,
          size: 52,
          values: (_u, vals) => vals.map((v) => fmtAxis(v)),
        },
      ],
      series: [
        {},
        {
          label,
          stroke: strokeColor,
          width: 2.5,
          // Smooth (spline) line with rounded joins/caps for a softer look.
          paths: uPlot.paths.spline?.(),
          points: { show: false },
          value: (_u, v) => (v == null ? "—" : fmtVal(v)),
        },
      ],
    };

    const plot = new uPlot(opts, data, el);
    plotRef.current = plot;

    const onResize = () => {
      if (containerRef.current) {
        plot.setSize({ width: containerRef.current.clientWidth || width, height });
      }
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      plot.destroy();
      plotRef.current = null;
    };
  }, [samples, stroke, unit, label, height, theme, syncKey, valueFormat, yAxisFormat, invertY]);

  // Top margin reserves a strip for the value pill that floats above the plot.
  return (
    <div
      ref={containerRef}
      style={{ width: "100%", maxWidth: "100%", overflow: "hidden", position: "relative", marginTop: 16 }}
    />
  );
}

// Memoized so per-frame cursor state in the parent doesn't rebuild every chart.
export const LineChart = memo(LineChartImpl);
