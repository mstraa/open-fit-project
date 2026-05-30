// Friendly aliases over the OpenAPI-generated schema (./generated/schema.d.ts,
// produced by `npm run gen:api` from ofit-api's utoipa OpenAPI document).
//
// These are the SOURCE OF TRUTH for API-boundary shapes: enums and raw DTOs
// here are regenerated from the server, so adding e.g. a StreamKind in Rust and
// re-running gen:api propagates to the web with zero hand-editing. The view
// model the UI consumes (see ./types.ts) is derived from / normalized out of
// these in ./endpoints.ts.

import type { components } from "./generated/schema";

type S = components["schemas"];

/* ---- enums (snake_case, straight from ofit-core via serde) ---- */
export type Sport = S["Sport"];
export type StreamKind = S["StreamKind"];
export type SourceKind = S["SourceKind"];
export type SelectionReason = S["SelectionReason"];
export type PreferenceScope = S["PreferenceScopeDto"];
export type WellnessKind = S["WellnessKind"];

/* ---- raw response DTOs (exact server shapes) ---- */
export type SourceDto = S["SourceDto"];
export type ActivitySummaryDto = S["ActivitySummary"];
export type ActivityDetailDto = S["ActivityDetail"];
export type RecordingDto = S["RecordingDto"];
export type ResolvedScalarMetricDto = S["ResolvedScalarMetric"];
export type TrackPointDto = S["TrackPoint"];
export type ScalarPointDto = S["ScalarPoint"];
export type PreferenceDtoRaw = S["PreferenceDto"];
export type SetPreferenceRequestDto = S["SetPreferenceRequest"];
export type ImportResponseDto = S["ImportResponse"];
export type ImportFileResultDto = S["ImportFileResult"];
export type WellnessResponseDto = S["WellnessResponse"];
export type HealthDto = S["Health"];
export type VersionDto = S["Version"];
