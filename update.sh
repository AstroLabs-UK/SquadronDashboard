#!/usr/bin/env bash
# Squadron Dashboard - update from GitHub, keeping this device's own settings.
#
# Runs shortly after every boot and every 30 minutes after that. Safe to run by
# hand any time:  bash update.sh
#
# Settings saved from /edit live in the data/ folder, which is git-ignored, so
# updating the code never touches them. This script also copies them to a safe
# place before updating and checks they're still there afterwards.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR" || exit 1

# Older versions kept settings in data.json next to server.js. Move them into data/
# (copy only - never delete - and never overwrite anything already in data/).
mkdir -p data
for f in data.json data.backup.json; do
  if [ -f "$f" ] && [ ! -f "data/$f" ]; then cp -p "$f" "data/$f"; fi
done
[ -f data/data.json ] || cp data.example.json data/data.json
[ -f data/data.backup.json ] || cp data/data.json data/data.backup.json

if ! git fetch --quiet 2>/dev/null; then
  echo "[update] can't reach GitHub - skipping this check"
  exit 0
fi

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse '@{u}')"
if [ "$LOCAL" = "$REMOTE" ]; then
  echo "[update] already up to date"
  exit 0
fi

echo "[update] update found - applying..."
KEEP="$(mktemp -d)"
cp -a data "$KEEP/data"           # safety copy of the settings

git reset --hard --quiet '@{u}'   # replaces code only; data/ is git-ignored so it's untouched

# Belt and braces: if anything about data/ went missing, put the safety copy back
mkdir -p data
for f in data.json data.backup.json; do
  [ -f "data/$f" ] || { [ -f "$KEEP/data/$f" ] && cp -p "$KEEP/data/$f" "data/$f"; }
done
rm -rf "$KEEP"

# Restart the app so the new code is running
if command -v docker >/dev/null 2>&1 && docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx 'squadron-dashboard'; then
  docker compose up -d --build
else
  npm install --omit=dev --quiet
  systemctl restart squadron-dashboard.service 2>/dev/null || sudo systemctl restart squadron-dashboard.service
fi
echo "[update] done"
