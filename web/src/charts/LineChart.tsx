// A theme-aware uPlot line chart for a single resolved scalar stream.
//
// uPlot draws to a <canvas>, so axis/grid colors don't inherit CSS. We read the
// current design tokens via getComputedStyle and rebuild the plot when the
// theme (or data) changes, keeping light/dark correct.

import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { useTheme } from "../theme/ThemeProvider";
import type { ScalarSample } from "../api/types";

function tokenColor(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

export interface LineChartProps {
  samples: ScalarSample[];
  /** Line stroke color (token-ish hex from format.ts). */
  stroke: string;
  unit: string;
  label: string;
  height?: number;
}

export function LineChart({
  samples,
  stroke,
  unit,
  label,
  height = 200,
}: LineChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  // `theme` is read so the effect re-runs and recolors on theme switch.
  const { theme } = useTheme();

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const xs = samples.map((s) => s.t_offset_ms / 1000);
    const ys = samples.map((s) => s.value);
    const data: uPlot.AlignedData = [xs, ys];

    const axisColor = tokenColor("--color-text-muted", "#888");
    const gridColor = tokenColor("--color-border", "#ccc");

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
      scales: { x: { time: false } },
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
        { ...axisStyle, size: 52 },
      ],
      series: [
        {},
        {
          label,
          stroke,
          width: 1.5,
          points: { show: false },
          value: (_u, v) => (v == null ? "—" : `${v.toFixed(0)} ${unit}`),
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
  }, [samples, stroke, unit, label, height, theme]);

  return <div ref={containerRef} style={{ width: "100%" }} />;
}
