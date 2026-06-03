// Lazy-loaded TrackMap.
//
// maplibre-gl (~100-150KB) is only needed on the activity-detail route, so the
// real TrackMap (which imports maplibre-gl synchronously) is code-split here via
// React.lazy and only fetched when a map is actually rendered. A lightweight
// placeholder keeps the layout stable while the chunk loads.

import { Suspense, lazy } from "react";
import type { TrackMapProps } from "./TrackMap";

const TrackMapInner = lazy(() => import("./TrackMap"));

export function TrackMap(props: TrackMapProps) {
  if (props.track.length === 0) return null;
  const height = props.height ?? 320;
  return (
    <Suspense
      fallback={
        <div
          style={{
            width: "100%",
            height,
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--color-border)",
            background: "var(--surface)",
          }}
        />
      }
    >
      <TrackMapInner {...props} />
    </Suspense>
  );
}

export type { TrackMapProps };
