// MapLibre GL map drawing a resolved LatLng track.
//
// Cloudless spirit: uses a key-free OSM raster style (OpenStreetMap tiles) — no
// vendor API key. The style object is inline so there's no external style JSON
// fetch beyond the raster tiles themselves.

import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import type { StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useTheme } from "../theme/ThemeProvider";
import { resolveCssColor } from "../ui/colors";
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
  height?: number;
}

export function TrackMap({ track, height = 320 }: TrackMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const { theme } = useTheme();

  // Line color follows the accent token (read at draw time).
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
      // MapLibre's color parser can't read oklch()/var(); normalize to rgb().
      const accent = resolveCssColor("var(--accent)", "#3d8bfd");

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

      // Start/end markers.
      new maplibregl.Marker({ color: "#1a9c5b" })
        .setLngLat(coords[0])
        .addTo(map);
      new maplibregl.Marker({ color: "#d23b3b" })
        .setLngLat(coords[coords.length - 1])
        .addTo(map);

      // Fit the whole track.
      const bounds = coords.reduce(
        (b, c) => b.extend(c),
        new maplibregl.LngLatBounds(coords[0], coords[0]),
      );
      map.fitBounds(bounds, { padding: 32, duration: 0 });
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // Re-init on theme so the accent line color refreshes.
  }, [track, theme]);

  if (track.length === 0) {
    return null;
  }

  return (
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
  );
}
