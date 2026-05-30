// MapLibre GL map drawing a resolved LatLng track.
//
// Cloudless spirit: uses a key-free OSM raster style (OpenStreetMap tiles) — no
// vendor API key. The style object is inline so there's no external style JSON
// fetch beyond the raster tiles themselves.
//
// - `colorValues` (per-track-point, same length as track) colors the path by a
//   metric (speed) using a relative gradient; falls back to a solid accent line.
// - `cursorMs` places a locator dot at the GPS position for that time (synced to
//   the charts' hover cursor).

import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import type { StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useTheme } from "../theme/ThemeProvider";
import { resolveCssColor } from "../ui/colors";
import { coordAtMs } from "./series";
import { speedColorExpression, speedDomain, SPEED_LEGEND_GRADIENT } from "./speedColor";
import type { LatLngSample } from "../api/types";

/** Key-free OSM raster style (attribution required, no token). */
const OSM_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

export interface TrackMapProps {
  track: LatLngSample[];
  /** Optional per-point metric (speed) to color the path; length === track. */
  colorValues?: number[];
  /** Time (ms since start) of the synced cursor; positions the locator dot. */
  cursorMs?: number | null;
  height?: number;
}

export function TrackMap({ track, colorValues, cursorMs, height = 320 }: TrackMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const cursorMarkerRef = useRef<maplibregl.Marker | null>(null);
  const cursorDotRef = useRef<HTMLDivElement | null>(null);
  const { theme } = useTheme();

  const colored = !!colorValues && colorValues.length === track.length && track.length > 1;

  // (Re)build the map when the track, coloring, or theme changes.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || track.length === 0) return;

    const coords: [number, number][] = track.map((p) => [p.lng, p.lat]);

    const map = new maplibregl.Map({
      container: el,
      style: OSM_STYLE,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    map.on("load", () => {
      const accent = resolveCssColor("var(--accent)", "#3d8bfd");

      if (colored && colorValues) {
        // One segment feature per pair, carrying the mean speed as `v`.
        const features = [];
        for (let i = 0; i < coords.length - 1; i++) {
          const v = (colorValues[i] + colorValues[i + 1]) / 2;
          features.push({
            type: "Feature" as const,
            properties: { v },
            geometry: { type: "LineString" as const, coordinates: [coords[i], coords[i + 1]] },
          });
        }
        const [lo, hi] = speedDomain(colorValues);
        map.addSource("track", {
          type: "geojson",
          data: { type: "FeatureCollection", features },
        });
        map.addLayer({
          id: "track-line",
          type: "line",
          source: "track",
          layout: { "line-cap": "round", "line-join": "round" },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          paint: { "line-color": speedColorExpression(lo, hi) as any, "line-width": 4 },
        });
      } else {
        map.addSource("track", {
          type: "geojson",
          data: {
            type: "Feature",
            properties: {},
            geometry: { type: "LineString", coordinates: coords },
          },
        });
        map.addLayer({
          id: "track-line",
          type: "line",
          source: "track",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": accent, "line-width": 4 },
        });
      }

      // Start / end markers.
      new maplibregl.Marker({ color: "#1a9c5b" }).setLngLat(coords[0]).addTo(map);
      new maplibregl.Marker({ color: "#d23b3b" }).setLngLat(coords[coords.length - 1]).addTo(map);

      // Locator dot synced to the chart cursor (hidden until hover).
      const dot = document.createElement("div");
      dot.style.cssText =
        "width:14px;height:14px;border-radius:50%;background:#fff;" +
        `border:3px solid ${accent};box-shadow:0 0 0 4px ${accent}55;` +
        "opacity:0;transition:opacity .1s;pointer-events:none;";
      cursorDotRef.current = dot;
      cursorMarkerRef.current = new maplibregl.Marker({ element: dot })
        .setLngLat(coords[0])
        .addTo(map);

      const bounds = coords.reduce(
        (b, c) => b.extend(c),
        new maplibregl.LngLatBounds(coords[0], coords[0]),
      );
      map.fitBounds(bounds, { padding: 32, duration: 0 });
    });

    return () => {
      map.remove();
      mapRef.current = null;
      cursorMarkerRef.current = null;
      cursorDotRef.current = null;
    };
  }, [track, colored, colorValues, theme]);

  // Move/show the locator dot when the synced cursor changes (no map rebuild).
  useEffect(() => {
    const marker = cursorMarkerRef.current;
    const dot = cursorDotRef.current;
    if (!marker || !dot) return;
    if (cursorMs == null) {
      dot.style.opacity = "0";
      return;
    }
    const c = coordAtMs(track, cursorMs);
    if (!c) {
      dot.style.opacity = "0";
      return;
    }
    marker.setLngLat(c);
    dot.style.opacity = "1";
  }, [cursorMs, track]);

  if (track.length === 0) return null;

  return (
    <div style={{ position: "relative" }}>
      <div
        ref={containerRef}
        style={{
          width: "100%",
          height,
          borderRadius: "var(--radius-sm)",
          overflow: "hidden",
          border: "1px solid var(--color-border)",
        }}
      />
      {colored && (
        <div
          style={{
            position: "absolute",
            left: 12,
            bottom: 12,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "5px 9px",
            borderRadius: 999,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            fontSize: 10.5,
            color: "var(--muted)",
            zIndex: 2,
          }}
        >
          <span>slow</span>
          <span
            aria-hidden
            style={{ width: 70, height: 6, borderRadius: 999, background: SPEED_LEGEND_GRADIENT }}
          />
          <span>fast</span>
          <span style={{ color: "var(--faint)" }}>· speed</span>
        </div>
      )}
    </div>
  );
}
