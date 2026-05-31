// A theme-aware uPlot multi-series line chart (used by the dashboard's training
// load / fitness card: CTL / ATL / TSB on a shared dated x-axis).
//
// Like LineChart, uPlot draws to a <canvas> so axis/grid colors don't inherit
// CSS — we read the current design tokens via getComputedStyle and rebuild the
// plot when the theme (or data) changes, keeping light/dark correct.
//
// `x` is an array of UNIX seconds (the time scale formats them as short dates);
// each series in `series` shares that x. Series strokes are CSS tokens/colors.

import { memo, useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { useTheme } from "../theme/ThemeProvider";
import { resolveCssColor } from "../ui/colors";

export interface MultiSeries {
  label: string;
  /** y-values, aligned 1:1 with `x` (null = gap). */
  values: (number | null)[];
  /** Stroke color (CSS token like `var(--accent)` or a literal color). */
  stroke: string;
}

export interface MultiLineChartProps {
  /** Shared x-axis in UNIX seconds. */
  x: number[];
  series: MultiSeries[];
  height?: number;
  unit?: string;
}

function tokenColor(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function fmtDate(sec: number): string {
  const d = new Date(sec * 1000);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function MultiLineChartImpl({ x, series, height = 220, unit = "" }: MultiLineChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  const { theme } = useTheme();

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const data: uPlot.AlignedData = [x, ...series.map((s) => s.values)];

    const axisColor = resolveCssColor(tokenColor("--color-text-muted", "#888"), "#888");
    const gridColor = resolveCssColor(tokenColor("--color-border", "#ccc"), "#ccc");
    const width = el.clientWidth || 600;

    const axisStyle = {
      stroke: axisColor,
      grid: { stroke: gridColor, width: 1 },
      ticks: { stroke: gridColor, width: 1 },
      font: "12px var(--font-sans, sans-serif)",
    };

    const opts: uPlot.Options = {
      width,
      height,
      cursor: { y: false },
      legend: { show: false },
      scales: {
        x: { time: false },
        y: {
          range: (_u, dataMin, dataMax) => {
            const lo = Math.min(0, dataMin);
            const pad = dataMax - lo || 1;
            return [lo - pad * 0.04, dataMax + pad * 0.1];
          },
        },
      },
      axes: [
        { ...axisStyle, values: (_u, vals) => vals.map((v) => fmtDate(v)) },
        {
          ...axisStyle,
          size: 46,
          values: (_u, vals) => vals.map((v) => `${Math.round(v)}${unit}`),
        },
      ],
      series: [
        { value: (_u, v) => (v == null ? "—" : fmtDate(v)) },
        ...series.map((s) => ({
          label: s.label,
          stroke: resolveCssColor(s.stroke, axisColor),
          width: 2.5,
          paths: uPlot.paths.spline?.(),
          points: { show: false },
        })),
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
  }, [x, series, height, unit, theme]);

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", maxWidth: "100%", overflow: "hidden", position: "relative", marginTop: 8 }}
    />
  );
}

export const MultiLineChart = memo(MultiLineChartImpl);
