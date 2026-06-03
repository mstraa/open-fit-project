/* ============================================================
   OpenFit redesign — chart primitives (SVG, animated, interactive).
   Ported from the design bundle's js/charts.jsx into typed TSX.
   ============================================================ */
import {
  useState,
  useEffect,
  useRef,
  useLayoutEffect,
  useMemo,
  useCallback,
  type CSSProperties,
} from "react";
import { scoreColor } from "./util";

export { scoreColor };

/** Measure a container's width so charts fill their card crisply. */
export function useWidth(): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((es) => {
      for (const e of es) setW(e.contentRect.width);
    });
    ro.observe(ref.current);
    setW(ref.current.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** One-shot mount animation flag (resolves to final state when doc is hidden). */
export function useMounted(delay = 30): boolean {
  const [on, setOn] = useState(() => typeof document !== "undefined" && document.hidden);
  useEffect(() => {
    if (typeof document !== "undefined" && document.hidden) {
      setOn(true);
      return;
    }
    const t = setTimeout(() => setOn(true), delay);
    return () => clearTimeout(t);
  }, [delay]);
  return on;
}

type NumLike = number | { v: number; [k: string]: unknown };
function num(d: NumLike): number {
  return typeof d === "number" ? d : d.v;
}
function niceDomain(vals: number[], padFrac = 0.12, force?: [number, number]): [number, number] {
  let lo = Math.min(...vals),
    hi = Math.max(...vals);
  if (force) {
    lo = Math.min(lo, force[0]);
    hi = Math.max(hi, force[1]);
  }
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const pad = (hi - lo) * padFrac;
  return [lo - pad, hi + pad];
}

/* ================= RING GAUGE ================= */
export function Ring({
  value,
  max = 100,
  size = 168,
  stroke = 13,
  color,
  label,
  sub,
  bigText,
  glow = true,
  bands,
}: {
  value: number;
  max?: number;
  size?: number;
  stroke?: number;
  color?: string;
  label?: string;
  sub?: string;
  bigText?: boolean;
  glow?: boolean;
  bands?: [number, number];
}) {
  const mounted = useMounted(80);
  const c = color || scoreColor(value, bands);
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, value / max));
  const valSize = Math.round(size * 0.3);
  const labelSize = Math.max(8.5, Math.round(size * 0.062));
  const inner = size - stroke;
  const labelStyle: CSSProperties =
    size < 130
      ? {
          fontSize: labelSize,
          letterSpacing: ".04em",
          maxWidth: inner,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }
      : { fontSize: Math.max(10.5, labelSize), letterSpacing: ".12em", whiteSpace: "nowrap" };
  return (
    <div className="ring" style={{ width: size, height: size }}>
      {/* Rotate the arc inside SVG space (about the true center) — NOT a CSS
          transform on the <svg>, which can rotate the whole box in some engines. */}
      <svg width={size} height={size}>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--track)" strokeWidth={stroke} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={c}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circ}
            strokeDashoffset={mounted ? circ * (1 - frac) : circ}
            style={{
              transition: "stroke-dashoffset 1.1s cubic-bezier(.22,1,.36,1)",
              filter: glow ? `drop-shadow(0 0 5px color-mix(in srgb, ${c} 28%, transparent))` : "none",
            }}
          />
        </g>
      </svg>
      <div className="ring-center">
        <div className="ring-val" style={{ color: bigText ? "var(--text)" : c, fontSize: valSize }}>
          <CountUp to={value} />
        </div>
        {label && (
          <div className="ring-label" style={labelStyle}>
            {label}
          </div>
        )}
        {sub && <div className="ring-sub" style={{ fontSize: Math.max(9, Math.round(size * 0.064)) }}>{sub}</div>}
      </div>
    </div>
  );
}

/* ================= COUNT-UP NUMBER ================= */
export function CountUp({ to, dur = 900, decimals = 0 }: { to: number; dur?: number; decimals?: number }) {
  const [v, setV] = useState(() => (typeof document !== "undefined" && document.hidden ? to : 0));
  useEffect(() => {
    if (typeof document !== "undefined" && document.hidden) {
      setV(to);
      return;
    }
    let raf = 0,
      t0 = 0,
      done = false;
    const tick = (t: number) => {
      if (!t0) t0 = t;
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      setV(to * e);
      if (p < 1) raf = requestAnimationFrame(tick);
      else done = true;
    };
    raf = requestAnimationFrame(tick);
    const safety = setTimeout(() => {
      if (!done) setV(to);
    }, dur + 250);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(safety);
    };
  }, [to, dur]);
  return <>{decimals ? v.toFixed(decimals) : Math.round(v)}</>;
}

/* ================= INTERACTIVE LINE CHART ================= */
export function LineChart({
  data,
  xLabels,
  height = 140,
  color = "var(--blue)",
  showDots = false,
  valueLabels = false,
  valueFmt = (v: number) => Math.round(v),
  fill = false,
  yDomain,
  interactive = true,
  dateFmt,
  padTop = 22,
  padBottom = 22,
  segColors,
}: {
  data: NumLike[];
  xLabels?: (string | null)[];
  height?: number;
  color?: string;
  showDots?: boolean;
  valueLabels?: boolean;
  valueFmt?: (v: number) => string | number;
  fill?: boolean;
  yDomain?: [number, number];
  interactive?: boolean;
  dateFmt?: (i: number) => string;
  padTop?: number;
  padBottom?: number;
  segColors?: string[];
}) {
  const [ref, w] = useWidth();
  const mounted = useMounted(60);
  const [active, setActive] = useState<number | null>(null);
  const vals = data.map(num);
  const dom = yDomain || niceDomain(vals, valueLabels ? 0.28 : 0.14);
  const H = height,
    padL = 8,
    padR = 8;
  const innerW = Math.max(1, w - padL - padR);
  const innerH = H - padTop - padBottom;
  const x = (i: number) => padL + (data.length <= 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);
  const y = (v: number) => padTop + innerH * (1 - (v - dom[0]) / (dom[1] - dom[0]));
  const pts = vals.map((v, i) => [x(i), y(v)] as const);
  const dPath = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const areaPath = dPath + ` L${x(data.length - 1).toFixed(1)} ${H - padBottom} L${padL} ${H - padBottom} Z`;
  const gid = useMemo(() => "g" + Math.random().toString(36).slice(2), []);

  const onMove = useCallback(
    (e: React.MouseEvent | React.TouchEvent) => {
      if (!interactive || !w) return;
      const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
      const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
      const px = clientX - rect.left;
      let i = Math.round(((px - padL) / innerW) * (data.length - 1));
      i = Math.max(0, Math.min(data.length - 1, i));
      setActive(i);
    },
    [w, innerW, data.length, interactive],
  );

  return (
    <div className="lc" ref={ref} style={{ height: H }}>
      {w > 0 && (
        <svg
          width={w}
          height={H}
          className="lc-svg"
          onMouseMove={onMove}
          onMouseLeave={() => setActive(null)}
          onTouchStart={onMove}
          onTouchMove={onMove}
          onTouchEnd={() => setActive(null)}
        >
          <defs>
            <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.18" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          {fill && (
            <path d={areaPath} fill={`url(#${gid})`} opacity={mounted ? 1 : 0} style={{ transition: "opacity .8s ease .3s" }} />
          )}
          <path
            d={dPath}
            fill="none"
            stroke={color}
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            pathLength={1}
            strokeDasharray="1"
            strokeDashoffset={mounted ? 0 : 1}
            style={{ transition: "stroke-dashoffset 1.05s cubic-bezier(.4,0,.2,1)" }}
          />
          {showDots &&
            pts.map((p, i) => (
              <circle
                key={`${i}:${vals[i]}`}
                cx={p[0]}
                cy={p[1]}
                r={active === i ? 4.5 : 3}
                fill="var(--bg-elev)"
                stroke={segColors ? segColors[i] : color}
                strokeWidth="2.2"
                opacity={mounted ? 1 : 0}
                style={{ transition: `opacity .4s ease ${0.4 + i * 0.03}s` }}
              />
            ))}
          {valueLabels &&
            pts.map((p, i) => (
              <text
                key={`${i}:${vals[i]}`}
                x={p[0]}
                y={p[1] - 11}
                textAnchor="middle"
                className="lc-vlabel"
                fill={segColors ? segColors[i] : color}
                opacity={mounted ? 1 : 0}
                style={{ transition: `opacity .4s ease ${0.5 + i * 0.03}s` }}
              >
                {valueFmt(vals[i])}
              </text>
            ))}
          {active != null && (
            <g>
              <line
                x1={pts[active][0]}
                x2={pts[active][0]}
                y1={padTop - 6}
                y2={H - padBottom}
                stroke="var(--line-strong)"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
              <circle cx={pts[active][0]} cy={pts[active][1]} r="5.5" fill={color} stroke="var(--bg-elev)" strokeWidth="2" />
            </g>
          )}
          {xLabels &&
            xLabels.map((lb, i) =>
              lb != null ? (
                <text key={`${lb}:${i}`} x={x(i)} y={H - 5} textAnchor="middle" className="lc-xlabel" fill="var(--text-faint)">
                  {lb}
                </text>
              ) : null,
            )}
        </svg>
      )}
      {active != null && (
        <div className="lc-tip" style={{ left: Math.max(6, Math.min(w - 80, pts[active][0] - 40)) }}>
          <b>{valueFmt(vals[active])}</b>
          {dateFmt && <span>{dateFmt(active)}</span>}
        </div>
      )}
    </div>
  );
}

/* ================= MIN/AVG/MAX BAND CHART ================= */
export interface BandPoint {
  min: number;
  avg: number;
  max: number;
}
export function BandChart({
  data,
  height = 150,
  color = "var(--hrv)",
  dateFmt,
}: {
  data: BandPoint[];
  height?: number;
  color?: string;
  dateFmt?: (i: number) => string;
}) {
  const [ref, w] = useWidth();
  const mounted = useMounted(60);
  const [active, setActive] = useState<number | null>(null);
  const allv = data.flatMap((d) => [d.min, d.max]);
  const dom = niceDomain(allv, 0.1);
  const H = height,
    padT = 14,
    padB = 16,
    padL = 6,
    padR = 6;
  const innerW = Math.max(1, w - padL - padR),
    innerH = H - padT - padB;
  const x = (i: number) => padL + (i / (data.length - 1)) * innerW;
  const y = (v: number) => padT + innerH * (1 - (v - dom[0]) / (dom[1] - dom[0]));
  const top = data.map((d, i) => [x(i), y(d.max)] as const);
  const bot = data.map((d, i) => [x(i), y(d.min)] as const);
  const band =
    top.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ") +
    " " +
    bot
      .slice()
      .reverse()
      .map((p) => "L" + p[0].toFixed(1) + " " + p[1].toFixed(1))
      .join(" ") +
    " Z";
  const avgPath = data.map((d, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(d.avg).toFixed(1)).join(" ");
  const onMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (!w) return;
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
    const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
    const px = clientX - rect.left;
    let i = Math.round(((px - padL) / innerW) * (data.length - 1));
    setActive(Math.max(0, Math.min(data.length - 1, i)));
  };
  return (
    <div className="lc" ref={ref} style={{ height: H }}>
      {w > 0 && (
        <svg
          width={w}
          height={H}
          className="lc-svg"
          onMouseMove={onMove}
          onMouseLeave={() => setActive(null)}
          onTouchStart={onMove}
          onTouchMove={onMove}
          onTouchEnd={() => setActive(null)}
        >
          <path d={band} fill={color} opacity={mounted ? 0.16 : 0} style={{ transition: "opacity .8s ease .2s" }} />
          <path
            d={avgPath}
            fill="none"
            stroke={color}
            strokeWidth="2.4"
            strokeLinecap="round"
            pathLength={1}
            strokeDasharray="1"
            strokeDashoffset={mounted ? 0 : 1}
            style={{ transition: "stroke-dashoffset 1s cubic-bezier(.4,0,.2,1)" }}
          />
          {active != null && (
            <g>
              <line x1={x(active)} x2={x(active)} y1={padT} y2={H - padB} stroke="var(--line-strong)" strokeWidth="1" strokeDasharray="3 3" />
              <circle cx={x(active)} cy={y(data[active].avg)} r="5" fill={color} stroke="var(--bg-elev)" strokeWidth="2" />
            </g>
          )}
        </svg>
      )}
      {active != null && (
        <div className="lc-tip" style={{ left: Math.max(6, Math.min(w - 96, x(active) - 48)) }}>
          <b>
            {data[active].avg} <span className="u">avg</span>
          </b>
          <span>
            {data[active].min}–{data[active].max}
            {dateFmt ? " · " + dateFmt(active) : ""}
          </span>
        </div>
      )}
    </div>
  );
}

/* ================= BARS ================= */
export interface BarPoint {
  d: string;
  v: number;
}
export function Bars({
  data,
  height = 150,
  color = "var(--good)",
  valueFmt = (v: number) => v,
  colorFn,
  zeroBase = true,
}: {
  data: BarPoint[];
  height?: number;
  color?: string;
  valueFmt?: (v: number) => string | number;
  colorFn?: (v: number, i: number) => string;
  zeroBase?: boolean;
}) {
  const [ref, w] = useWidth();
  const mounted = useMounted(60);
  // Y-domain only depends on the data (+ zeroBase); memoize so it isn't
  // recomputed on every render (e.g. resize / hover state changes elsewhere).
  const { lo, hi } = useMemo(() => {
    const vs = data.map((d) => d.v);
    return {
      lo: zeroBase ? Math.min(0, ...vs) : Math.min(...vs) * 0.9,
      hi: Math.max(...vs) * 1.12,
    };
  }, [data, zeroBase]);
  const H = height,
    padT = 20,
    padB = 22;
  const innerH = H - padT - padB;
  const bw = Math.min(26, (w / data.length) * 0.42);
  const x = (i: number) => (i + 0.5) * (w / data.length);
  const y = (v: number) => padT + innerH * (1 - (v - lo) / (hi - lo));
  return (
    <div className="lc" ref={ref} style={{ height: H }}>
      {w > 0 && (
        <svg width={w} height={H} className="lc-svg">
          {data.map((d, i) => {
            const v = d.v;
            const c = colorFn ? colorFn(v, i) : color;
            const yy = y(v),
              y0 = y(Math.max(0, lo));
            const h = Math.abs(yy - y0);
            return (
              <g key={d.d}>
                <rect
                  x={x(i) - bw / 2}
                  y={mounted ? Math.min(yy, y0) : y0}
                  width={bw}
                  height={mounted ? h : 0}
                  rx={bw / 2.6}
                  fill={c}
                  style={{ transition: `all .8s cubic-bezier(.22,1,.36,1) ${i * 0.04}s` }}
                />
                <text
                  x={x(i)}
                  y={yy - 7}
                  textAnchor="middle"
                  className="lc-vlabel"
                  fill={c}
                  opacity={mounted ? 1 : 0}
                  style={{ transition: `opacity .5s ease ${0.4 + i * 0.04}s` }}
                >
                  {valueFmt(v)}
                </text>
                <text x={x(i)} y={H - 6} textAnchor="middle" className="lc-xlabel" fill="var(--text-faint)">
                  {d.d}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

/* ================= STACKED BARS ================= */
export function StackedBars<K extends string>({
  data,
  keys,
  colors,
  height = 160,
}: {
  data: (Record<K, number> & { d: string })[];
  keys: K[];
  colors: string[];
  height?: number;
}) {
  const [ref, w] = useWidth();
  const mounted = useMounted(60);
  const totals = data.map((d) => keys.reduce((s, k) => s + d[k], 0));
  const hi = Math.max(...totals) * 1.08;
  const H = height,
    padT = 12,
    padB = 22,
    innerH = H - padT - padB;
  const bw = Math.min(26, (w / data.length) * 0.46);
  const x = (i: number) => (i + 0.5) * (w / data.length);
  return (
    <div className="lc" ref={ref} style={{ height: H }}>
      {w > 0 && (
        <svg width={w} height={H} className="lc-svg">
          {data.map((d, i) => {
            let acc = 0;
            return (
              <g key={d.d}>
                {keys.map((k, ki) => {
                  const v = d[k];
                  const hSeg = (v / hi) * innerH;
                  acc += hSeg;
                  return (
                    <rect
                      key={k}
                      x={x(i) - bw / 2}
                      y={padT + innerH - (mounted ? acc : 0)}
                      width={bw}
                      height={mounted ? hSeg : 0}
                      fill={colors[ki]}
                      rx={ki === keys.length - 1 ? 3 : 0}
                      style={{ transition: `all .8s cubic-bezier(.22,1,.36,1) ${i * 0.04}s` }}
                    />
                  );
                })}
                <text x={x(i)} y={H - 6} textAnchor="middle" className="lc-xlabel" fill="var(--text-faint)">
                  {d.d}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

/* ================= REGULARITY BARS (bed → wake) ================= */
export function RegularityBars({
  data,
  height = 170,
}: {
  data: { d: string; bed: number; wake: number }[];
  height?: number;
}) {
  const [ref, w] = useWidth();
  const mounted = useMounted(60);
  // Unwrap onto a continuous sleep timeline: a time after midnight (bed 01:48 or
  // wake 09:33, both < noon) becomes +24, so bed < wake numerically and the bar
  // spans the night contiguously.
  const unwrap = (h: number) => (h < 12 ? h + 24 : h);
  const beds = data.map((d) => unwrap(d.bed));
  const wakes = data.map((d) => unwrap(d.wake));
  // Auto-fit the vertical scale to the actual nights and CENTER the band (min 5h
  // window so a steady schedule isn't exaggerated), so bars sit centered rather
  // than clustered low. Consistent schedule → aligned bars; irregular → visible
  // scatter (the point of the card).
  const minT = Math.min(...beds, ...wakes);
  const maxT = Math.max(...beds, ...wakes);
  const span = Math.max(5, maxT - minT + 1.5);
  const mid = (minT + maxT) / 2;
  const lo = mid - span / 2;
  const H = height,
    padT = 26,
    padB = 24,
    innerH = H - padT - padB;
  const bw = Math.min(20, (w / data.length) * 0.42);
  const x = (i: number) => (i + 0.5) * (w / data.length);
  // Invert: later time → higher up (smaller y), so WAKE sits at the TOP.
  const yy = (t: number) => padT + innerH * (1 - (t - lo) / span);
  const fmtClock = (h: number) => {
    const hh = Math.floor(h % 24);
    const mm = Math.round((h - Math.floor(h)) * 60);
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  };
  return (
    <div className="lc" ref={ref} style={{ height: H }}>
      {w > 0 && (
        <svg width={w} height={H} className="lc-svg">
          {data.map((d, i) => {
            const yWake = yy(unwrap(d.wake)); // later → top
            const yBed = yy(unwrap(d.bed)); // earlier → bottom
            const top = Math.min(yWake, yBed);
            const bot = Math.max(yWake, yBed);
            return (
              <g key={d.d} opacity={mounted ? 1 : 0} style={{ transition: `opacity .6s ease ${i * 0.05}s` }}>
                <text x={x(i)} y={top - 6} textAnchor="middle" className="lc-vlabel" fill="var(--light)">
                  {fmtClock(d.wake)}
                </text>
                <rect x={x(i) - bw / 2} y={top} width={bw} height={Math.max(2, bot - top)} rx={bw / 2.4} fill="var(--light)" opacity="0.92" />
                <text x={x(i)} y={bot + 14} textAnchor="middle" className="lc-vlabel" fill="var(--light)">
                  {fmtClock(d.bed)}
                </text>
                <text x={x(i)} y={H - 5} textAnchor="middle" className="lc-xlabel" fill="var(--text-faint)">
                  {d.d}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

/* ================= HYPNOGRAM ================= */
export type SleepStage = "awake" | "rem" | "light" | "deep";
const STAGE_ORDER: SleepStage[] = ["awake", "rem", "light", "deep"];
const STAGE_COLOR: Record<SleepStage, string> = {
  awake: "var(--awake)",
  rem: "var(--rem)",
  light: "var(--light)",
  deep: "var(--deep)",
};
export function Hypnogram({
  segs,
  height = 120,
  start = "00:11",
  end = "08:15",
}: {
  segs: { stage: SleepStage; len: number }[];
  height?: number;
  start?: string;
  end?: string;
}) {
  const [ref, w] = useWidth();
  const mounted = useMounted(60);
  const total = segs.reduce((s, x) => s + x.len, 0);
  const H = height,
    padB = 18,
    lane = (H - padB) / 4;
  let acc = 0;
  return (
    <div className="lc" ref={ref} style={{ height: H }}>
      {w > 0 && (
        <svg width={w} height={H} className="lc-svg">
          {segs.map((sg, i) => {
            const x0 = (acc / total) * w;
            const wSeg = (sg.len / total) * w;
            acc += sg.len;
            const li = STAGE_ORDER.indexOf(sg.stage);
            const yTop = li * lane + 3;
            return (
              <rect
                key={`${i}:${sg.stage}`}
                x={x0}
                y={yTop}
                width={Math.max(1.2, wSeg - 1)}
                height={lane - 6}
                rx="2.5"
                fill={STAGE_COLOR[sg.stage]}
                opacity={mounted ? 0.95 : 0}
                style={{ transition: `opacity .5s ease ${Math.min(0.8, i * 0.02)}s` }}
              />
            );
          })}
          <text x={2} y={H - 4} className="lc-xlabel" fill="var(--text-faint)">
            {start}
          </text>
          <text x={w - 2} y={H - 4} textAnchor="end" className="lc-xlabel" fill="var(--text-faint)">
            {end}
          </text>
        </svg>
      )}
    </div>
  );
}

/* ================= SEGMENT BAR ================= */
export function SegBar({ parts, height = 12 }: { parts: { v: number; color: string }[]; height?: number }) {
  const mounted = useMounted(60);
  const total = parts.reduce((s, p) => s + p.v, 0) || 1;
  return (
    <div className="segbar" style={{ height }}>
      {parts.map((p, i) => (
        <div
          key={`${p.color}:${i}`}
          style={{
            width: mounted ? `${(p.v / total) * 100}%` : "0%",
            background: p.color,
            transition: `width .9s cubic-bezier(.22,1,.36,1) ${i * 0.08}s`,
          }}
        />
      ))}
    </div>
  );
}

/* ================= MINI SPARKLINE ================= */
export function Spark({
  data,
  color = "var(--blue)",
  width = 64,
  height = 26,
}: {
  data: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  const mounted = useMounted(60);
  const vals = data;
  const dom = niceDomain(vals, 0.15);
  const x = (i: number) => (i / (vals.length - 1)) * width;
  const y = (v: number) => height - 2 - (height - 4) * ((v - dom[0]) / (dom[1] - dom[0]));
  const d = vals.map((v, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1)).join(" ");
  return (
    <svg width={width} height={height} className="spark">
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={1}
        strokeDasharray="1"
        strokeDashoffset={mounted ? 0 : 1}
        style={{ transition: "stroke-dashoffset .9s ease" }}
      />
    </svg>
  );
}

/* ================= GROUPED MULTI-LINE ================= */
export interface MultiSeries {
  color: string;
  short: string;
  data: number[];
}
export function MultiLine({
  series,
  height = 170,
  dateFmt,
  interactive = true,
}: {
  series: MultiSeries[];
  height?: number;
  dateFmt?: (i: number) => string;
  interactive?: boolean;
}) {
  const [ref, w] = useWidth();
  const mounted = useMounted(60);
  const [active, setActive] = useState<number | null>(null);
  const all = series.flatMap((s) => s.data);
  const dom = niceDomain(all, 0.12);
  const n = series[0]?.data.length ?? 0;
  const H = height,
    padT = 12,
    padB = 18,
    padL = 6,
    padR = 6;
  const innerW = Math.max(1, w - padL - padR),
    innerH = H - padT - padB;
  const x = (i: number) => padL + (i / (n - 1)) * innerW;
  const y = (v: number) => padT + innerH * (1 - (v - dom[0]) / (dom[1] - dom[0]));
  const onMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (!w || !interactive) return;
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
    const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
    const px = clientX - rect.left;
    let i = Math.round(((px - padL) / innerW) * (n - 1));
    setActive(Math.max(0, Math.min(n - 1, i)));
  };
  return (
    <div className="lc" ref={ref} style={{ height: H }}>
      {w > 0 && (
        <svg
          width={w}
          height={H}
          className="lc-svg"
          onMouseMove={onMove}
          onMouseLeave={() => setActive(null)}
          onTouchStart={onMove}
          onTouchMove={onMove}
          onTouchEnd={() => setActive(null)}
        >
          <line x1={padL} x2={w - padR} y1={y(0)} y2={y(0)} stroke="var(--line)" strokeWidth="1" />
          {series.map((s, si) => {
            const d = s.data.map((v, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1)).join(" ");
            return (
              <path
                key={si}
                d={d}
                fill="none"
                stroke={s.color}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                pathLength={1}
                strokeDasharray="1"
                strokeDashoffset={mounted ? 0 : 1}
                style={{ transition: `stroke-dashoffset 1.1s cubic-bezier(.4,0,.2,1) ${si * 0.12}s` }}
              />
            );
          })}
          {active != null && (
            <g>
              <line x1={x(active)} x2={x(active)} y1={padT} y2={H - padB} stroke="var(--line-strong)" strokeWidth="1" strokeDasharray="3 3" />
              {series.map((s, si) => (
                <circle key={si} cx={x(active)} cy={y(s.data[active])} r="4" fill={s.color} stroke="var(--bg-elev)" strokeWidth="1.5" />
              ))}
            </g>
          )}
        </svg>
      )}
      {active != null && (
        <div className="lc-tip wide" style={{ left: Math.max(6, Math.min(w - 130, x(active) - 65)) }}>
          {dateFmt && <span className="tip-date">{dateFmt(active)}</span>}
          {series.map((s, si) => (
            <b key={si} style={{ color: s.color }}>
              {s.short} {Math.round(s.data[active])}
            </b>
          ))}
        </div>
      )}
    </div>
  );
}

/* ================= AREA CHART (Garmin-style filled) ================= */
export function AreaChart({
  data,
  color = "var(--rhr)",
  height = 150,
  durSec = 4004,
  valueFmt = (v: number) => Math.round(v),
  ticks = 4,
}: {
  data: number[];
  color?: string;
  height?: number;
  durSec?: number;
  valueFmt?: (v: number) => string | number;
  invert?: boolean;
  ticks?: number;
}) {
  const [ref, w] = useWidth();
  const mounted = useMounted(60);
  const [active, setActive] = useState<number | null>(null);
  const vals = data;
  let lo = Math.min(...vals),
    hi = Math.max(...vals);
  const pad = (hi - lo) * 0.12 || 1;
  lo -= pad;
  hi += pad;
  const H = height,
    padT = 8,
    padB = 20,
    padL = 38,
    padR = 6;
  const innerW = Math.max(1, w - padL - padR),
    innerH = H - padT - padB;
  const x = (i: number) => padL + (i / (vals.length - 1)) * innerW;
  const y = (v: number) => padT + innerH * (1 - (v - lo) / (hi - lo));
  const line = vals.map((v, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1)).join(" ");
  const area = line + ` L${x(vals.length - 1).toFixed(1)} ${padT + innerH} L${padL} ${padT + innerH} Z`;
  const gid = useMemo(() => "a" + Math.random().toString(36).slice(2), []);
  const yticks: number[] = [];
  for (let i = 0; i <= ticks; i++) yticks.push(lo + (hi - lo) * (i / ticks));
  const fmtTime = (frac: number) => {
    const s = Math.round(frac * durSec);
    const h = Math.floor(s / 3600),
      m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${String(m).padStart(2, "0")}` : `${m}:00`;
  };
  const onMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (!w) return;
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
    const px = clientX - r.left;
    let i = Math.round(((px - padL) / innerW) * (vals.length - 1));
    setActive(Math.max(0, Math.min(vals.length - 1, i)));
  };
  return (
    <div className="lc" ref={ref} style={{ height: H }}>
      {w > 0 && (
        <svg
          width={w}
          height={H}
          className="lc-svg"
          onMouseMove={onMove}
          onMouseLeave={() => setActive(null)}
          onTouchStart={onMove}
          onTouchMove={onMove}
          onTouchEnd={() => setActive(null)}
        >
          <defs>
            <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.55" />
              <stop offset="100%" stopColor={color} stopOpacity="0.12" />
            </linearGradient>
          </defs>
          {yticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={w - padR} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth="1" />
              <text x={padL - 6} y={y(t) + 3} textAnchor="end" className="lc-xlabel" fill="var(--text-faint)">
                {valueFmt(t)}
              </text>
            </g>
          ))}
          <path d={area} fill={`url(#${gid})`} opacity={mounted ? 1 : 0} style={{ transition: "opacity .7s ease .15s" }} />
          <path
            d={line}
            fill="none"
            stroke={color}
            strokeWidth="1.8"
            strokeLinejoin="round"
            pathLength={1}
            strokeDasharray="1"
            strokeDashoffset={mounted ? 0 : 1}
            style={{ transition: "stroke-dashoffset 1s ease" }}
          />
          {/* Static literal array (fixed 5 ticks, never filtered) → index key is stable. */}
          {[0, 0.25, 0.5, 0.75, 1].map((f, i) => (
            <text
              key={i}
              x={padL + f * innerW}
              y={H - 5}
              textAnchor={i === 0 ? "start" : i === 4 ? "end" : "middle"}
              className="lc-xlabel"
              fill="var(--text-faint)"
            >
              {fmtTime(f)}
            </text>
          ))}
          {active != null && (
            <g>
              <line x1={x(active)} x2={x(active)} y1={padT} y2={padT + innerH} stroke="var(--line-strong)" strokeWidth="1" strokeDasharray="3 3" />
              <circle cx={x(active)} cy={y(vals[active])} r="4.5" fill={color} stroke="var(--bg-elev)" strokeWidth="2" />
            </g>
          )}
        </svg>
      )}
      {active != null && (
        <div className="lc-tip" style={{ left: Math.max(6, Math.min(w - 80, x(active) - 40)) }}>
          <b>{valueFmt(vals[active])}</b>
          <span>{fmtTime(active / (vals.length - 1))}</span>
        </div>
      )}
    </div>
  );
}
