#!/usr/bin/env bash
# Pulls the latest Sotto and reinstalls (keeps your library and settings).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
git -C "$ROOT" pull --ff-only
exec "$ROOT/scripts/install.sh"
