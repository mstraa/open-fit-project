#!/usr/bin/env bash
# Dev tool — simulate a continuous wellness feed so the Wellness dashboard and
# the live WebSocket light up WITHOUT real hardware. Posts to POST /api/wellness
# (the same streaming/relay ingest path a Gadgetbridge relay will use).
#
# Usage:
#   scripts/wellness-sim.sh                 # live HR ~1/s + a daily-stats seed
#   API=http://localhost:8087 scripts/wellness-sim.sh
#   TOKEN=mytoken scripts/wellness-sim.sh   # if OFIT_TOKEN auth is enabled
#
# Clearly-synthetic data — replace with a real Gadgetbridge relay in Phase 2a.

set -eo pipefail
API="${API:-http://localhost:8087}"

post() {
  if [ -n "${TOKEN:-}" ]; then
    curl -s -H "Authorization: Bearer ${TOKEN}" -H 'content-type: application/json' -X POST "$API/api/wellness" -d "$1" >/dev/null
  else
    curl -s -H 'content-type: application/json' -X POST "$API/api/wellness" -d "$1" >/dev/null
  fi
}

iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# One-time seed: a few days of overnight resting HR / HRV / stress / body battery
# so the trend cards have history. (macOS `date -v`; falls back to today only.)
echo "seeding wellness history…"
for d in 6 5 4 3 2 1 0; do
  ts=$(date -u -v-"${d}"d +%Y-%m-%dT07:00:00Z 2>/dev/null || iso)
  rhr=$((46 + RANDOM % 8)); hrv=$((58 + RANDOM % 20)); stress=$((18 + RANDOM % 25)); bb=$((70 + RANDOM % 25))
  post "[{\"kind\":\"resting_heart_rate\",\"value\":$rhr,\"ts\":\"$ts\"},
        {\"kind\":\"hrv\",\"value\":$hrv,\"ts\":\"$ts\"},
        {\"kind\":\"stress\",\"value\":$stress,\"ts\":\"$ts\"},
        {\"kind\":\"body_battery\",\"value\":$bb,\"ts\":\"$ts\"}]"
done

echo "streaming live heart rate to $API … (Ctrl-C to stop)"
hr=62
while true; do
  hr=$(( hr + (RANDOM % 7) - 3 )); [ $hr -lt 45 ] && hr=45; [ $hr -gt 175 ] && hr=175
  post "[{\"kind\":\"heart_rate\",\"value\":$hr}]"
  sleep 1
done
