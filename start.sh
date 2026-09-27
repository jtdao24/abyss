#!/usr/bin/env bash
# Kept for muscle memory: the real launcher is start.py (works on every OS).
#   ./start.sh [--fake|--haiku|--live]
set -euo pipefail
exec python3 "$(cd "$(dirname "$0")" && pwd)/start.py" "$@"
