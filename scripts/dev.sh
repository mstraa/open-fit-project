#!/usr/bin/env bash
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cleanup() {
  echo ""
  echo "Stopping..."
  kill "$API_PID" "$WEB_PID" 2>/dev/null
  wait "$API_PID" "$WEB_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

echo "Starting ofit-api..."
cargo run -p ofit-api &
API_PID=$!

echo "Starting web dev server..."
cd "$ROOT/web" && npm run dev &
WEB_PID=$!

wait "$API_PID" "$WEB_PID"
