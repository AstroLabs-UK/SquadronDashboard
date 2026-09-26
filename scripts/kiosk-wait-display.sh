#!/usr/bin/env bash
# Wait until a display is available, then start Chromium kiosk on the dashboard.
# Use from autostart instead of launching chromium immediately.
set -euo pipefail
URL="${SQNDASH_URL:-http://localhost:3000}"
MAX_WAIT="${SQNDASH_DISPLAY_WAIT:-120}"  # seconds
INTERVAL=2
elapsed=0

has_display() {
  # X11
  if [ -n "${DISPLAY:-}" ] && command -v xdpyinfo >/dev/null 2>&1; then
    xdpyinfo >/dev/null 2>&1 && return 0
  fi
  # sysfs DRM connectors (Pi / modern Linux)
  for st in /sys/class/drm/card*-*/status; do
    [ -f "$st" ] || continue
    if grep -qx connected "$st" 2>/dev/null; then return 0; fi
  done
  # fallback: framebuffer node present
  [ -e /dev/fb0 ] && return 0
  return 1
}

echo "[kiosk] waiting up to ${MAX_WAIT}s for a display…"
while [ "$elapsed" -lt "$MAX_WAIT" ]; do
  if has_display; then
    echo "[kiosk] display detected after ${elapsed}s"
    break
  fi
  sleep "$INTERVAL"
  elapsed=$((elapsed + INTERVAL))
done

# Prefer chromium-browser, then chromium, then google-chrome
BROWSER=""
for c in chromium-browser chromium google-chrome; do
  if command -v "$c" >/dev/null 2>&1; then BROWSER="$c"; break; fi
done
if [ -z "$BROWSER" ]; then
  echo "[kiosk] no chromium found" >&2
  exit 1
fi

# Wait briefly for the dashboard server
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf -o /dev/null --max-time 2 "$URL" 2>/dev/null; then break; fi
  sleep 2
done

exec "$BROWSER" --kiosk --noerrdialogs --disable-infobars --disable-session-crashed-bubble   --check-for-update-interval=31536000 "$URL"
