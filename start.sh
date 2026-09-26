#!/usr/bin/env bash
# Start Abyss: the backend, the live market view in your browser, and the
# terminal chat (where you give the main agent jobs) in its own window.
#
#   ./start.sh           fake mode: no AI calls, costs nothing
#   ./start.sh --haiku   real calls, every agent runs on Haiku (cheap)
#   ./start.sh --live    real models for every role (costs money)
#
# Finished files are saved to ~/Downloads by the chat window.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
MODE="${1:---fake}"
case "$MODE" in
  --fake)  BACKEND_ENV="ABYSS_FAKE_LLM=1" ;;
  --haiku) BACKEND_ENV="" ;;
  --live)  BACKEND_ENV="ABYSS_REAL_MODELS=1" ;;
  *) echo "usage: $0 [--fake|--haiku|--live]"; exit 1 ;;
esac

cd "$ROOT/backend"
env $BACKEND_ENV .venv/bin/uvicorn abyss.server:app --port 8000 --log-level warning &
BACKEND=$!
cd "$ROOT/web"
npm run dev -- --port 5173 --strictPort >/dev/null 2>&1 &
WEB=$!
trap 'kill $BACKEND $WEB 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  if curl -fs localhost:8000/health >/dev/null && curl -fs localhost:5173 >/dev/null; then break; fi
  sleep 0.5
done

open "http://localhost:5173/"
osascript \
  -e "tell application \"Terminal\" to do script \"cd '$ROOT/backend' && .venv/bin/python -m abyss.chat\"" \
  -e 'tell application "Terminal" to activate' >/dev/null

echo "Abyss is running (${MODE#--} mode). The chat opened in a new Terminal window."
echo "Press Ctrl-C here to stop the market."
wait
